/**
 * Webserver for the sensorconfiguration. Uses a mongodb instance for 
 * storing users, sensors and configurations. Uses express.js for 
 * routing and passport.js with client-sessions for authentication.
 * 
 * DB layout (required fields without _id):
 * collection user: indexed on username, schema: schemas/user_schema.json
 * collection sensor: indexed on ID, schema: schemas/sensor_schema.json 
 *      + additional "users" array containing usernames
 * collection config: indexed on (type, version) combination,
 *                    schema: schemas/config_schema.json
 * collection secrets: "key" / "value" pairs
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const express = require('express');
const path = require('path');
const icons = require('glyphicons');
const body_parser = require('body-parser');
const util = require('util');
const session = require('client-sessions');
const node_red_comm = require('./node-red-comm');
const MongoClient = require('mongodb').MongoClient;
const passport = require('passport');
const Strategy = require('passport-local').Strategy;
const bcrypt = require('bcrypt');
const loginControl = require('connect-ensure-login');
const flash = require('connect-flash');

var JSONSchemaValidator = require('jsonschema').Validator;

const app = express();

const hostname = '0.0.0.0';
const port = 3033;

/**
 * From: https://stackoverflow.com/questions/4597900/checking-something-isempty-in-javascript
 * Check if the given value is empty.
 * @param value an arbitray value
 **/
function isEmpty(value) {
    var isEmptyObject = function(a) {
      if (typeof a.length === 'undefined') { // it's an Object, not an Array
        var hasNonempty = Object.keys(a).some(function nonEmpty(element){
          return !isEmpty(a[element]);
        });
        return hasNonempty ? false : isEmptyObject(Object.keys(a));
      }
  
      return !a.some(function nonEmpty(element) { // check if array is really not empty as JS thinks
        return !isEmpty(element); // at least one element should be non-empty
      });
    };
    return (
      value == false
      || typeof value === 'undefined'
      || value == null
      || (typeof value === 'object' && isEmptyObject(value))
    );
  }

// Existing roles for users
const roles = {admin: "admin", standarduser: "standarduser"};

//URL to local mongo running on port 27017
const dburl = 'mongodb://127.0.0.1:27017/sensorconfigdb';
const dbname = 'sensorconfigdb';
var dbrep = undefined;

/**
 * Connects to the database if not already connected.
 * @return the database connection
 */
async function db() {
    if(dbrep == undefined) {
        var client = await MongoClient.connect(dburl).catch(e => console.error("Could not connect to MongoDB at " + dburl + ", cause: " + e.message));
        dbrep = client.db(dbname);
        console.log("Using database " + dbrep);
    }
    return dbrep;
}

//First establish a database connection
db().then(db => {

    var session_secret_rep;

    /**
     * Get the session secret from the database if it is not available yet.
     * @return the session secret string
     */
    async function session_secret() {
        if(session_secret_rep == undefined) {
            var keyobj = await db.collection('secrets').findOne({key: 'session_key'})
                .catch(e => "Could not find session_key: " + e.message);
            session_secret_rep = keyobj.value;
            console.log("Using session key: " + session_secret_rep);
        }
        return session_secret_rep;
    }

    //Configure passport
    passport.use(new Strategy(
        function(username, password, callback) {
            //Find a user with username in the db, check the password and allow or deny authentication request
            db.collection("users").findOne({username: username}, function(err, user) {
                console.log("Got user: " + util.inspect(user));
                //Error during db query
                if(err) { console.error("Error during authentication: " + err); return callback(err); }
                //User does not exist
                if(!user) { console.log("Incorrect username"); return callback(null, false, {message: 'Incorrect username.'}); }
                //Password does not match
                if(!bcrypt.compareSync(password, user.passwordHash)) {
                    console.log("Incorrect password");
                    return callback(null, false, {message: 'Incorrect password.'});
                }
                //Everything okay
                return callback(null, user);
            });
        }
    ));

    /**
     * Passport helper for providing user object in req parameter for express routes.
     */
    passport.serializeUser(function(user, callback) {
        callback(null, user.username);
    });

    /**
     * Passport helper for providing user object in req parameter for express routes.
     */
    passport.deserializeUser(function(username, cb) {
        db.collection("users").findOne({username: username}, function(err, user) {
            if(err) { console.error("Cannot deserialize user: " + err.message); return cb(err); }
            //console.log("deserialized user: " + util.inspect(user));
            cb(null, user);
        });
    })

    app.use(body_parser.urlencoded());
    app.use(body_parser.json());

    app.use(require('cookie-parser')());

    //Ensure session secret is loaded
    session_secret().then( session_secret => 
    {
        //Session for storing user information
        app.use(require('express-session')({ 
            secret: session_secret, 
            resave: false, 
            saveUninitialized: false 
        }));
        //Flash for passing messages on redirects
        app.use(flash());
        app.use(passport.initialize());
        app.use(passport.session());

        //Make paths on filesystem available in express
        app.use('/vendor', express.static(__dirname + '/vendor'));
        app.use('/img', express.static(__dirname + '/img'));
        app.use('/schemas', express.static(__dirname + '/schemas'));

        //Use ejs view engine to render pages
        app.set('view engine', 'ejs');

        /* Init all variables to default value */
        app.use(function (req, res, next) {
            res.locals.activepage = null;
            next();
        });

        /**
         * Request a list of all sensorobjects the given user is allowed to see / manage.
         * @param user a userobject  
         */
        var getSensorsForUserFcn = async function(user) {
            if(user.role == roles.admin) {
                return db.collection("sensors").find({}, {fields: {_id: 0}, sort:"ID"}).toArray();
            }
            console.log("Looking for sensors: " + user.sensors);
            return db.collection("sensors").find({ID: {"$in": user.sensors}}, {fields: {_id: 0}, sort:"ID"}).toArray();
        }

        /**
         * Render mainpage function
         * @param req 
         * @param res 
         * @param alertType "success", "failure" or ""
         * @param alertText message to display
         */
        var indexfcn = async function(req, res, alertType, alertText) {
            var sensors = await getSensorsForUserFcn(req.user).catch(e => console.error("Could not get sensors, cause: " + e.message));
            sensors.forEach(s => {
                s.users.sort();
            });
            db.collection("users").find({}, {fields: {username: 1}, sort:"username"}).toArray()
                .then(userobjs => {
                    var usernames = userobjs.map(userobj => userobj.username);
                    res.render('pages/index', {sensors: sensors, user: req.user, usernames: usernames, alertType:alertType, alertText:alertText});
                })
                .catch(e => console.error("Could not get usernames, cause: " + e.message));
        };

        // default route
        app.get('/', loginControl.ensureLoggedIn('/login'), (req, res) => {
            indexfcn(req, res, '', '');
        });
        // '/index' route
        app.get('/index', loginControl.ensureLoggedIn('/login'), (req, res) => {
            indexfcn(req, res, '', '');
        });

        // '/index' post
        // expected request body: {'any_form_control_name': 'any text'}
        // 'any_from_control_name' should end with '_delete_btn', '_edit_btn' or '_deploy_btn'
        app.post('/index', loginControl.ensureLoggedIn('/login'), async function(req,res) {
            console.log("Got data: " + util.inspect(req.body));
            sensorAction = Object.keys(req.body)[0];
            if(sensorAction.endsWith("_delete_btn")) {
                // Delete action requested 
                console.log("Deleting: " + sensorAction.replace("_delete_btn", ""));
                sensor = sensorAction.replace("_delete_btn", "");
                if(req.user.role == roles.admin || req.user.sensors.includes(sensor)) {
                    // Cascading deletion: remove sensorid from every user.sensor, then delete sensor from sensors collection
                    db.collection("sensors").findOne({ID: sensor})
                        .then(sensorobj => {
                            db.collection("users").updateMany({username: {"$in": sensorobj.users}}, {"$pull": {sensors: sensor}})
                                .then(db.collection("sensors").deleteOne({ID: sensor}))
                                    .then(() => {
                                            node_red_comm.deleteFlowForSensorId(sensor, async function(success) {
                                            alertType = success ? 'success':'failure';
                                            alertText = '<strong>' + sensor + (success ? ' has been deleted successfully!': ' has dependent flows that could not be deleted. Please do that manually in Node-RED at port 1880!') +'</strong>';
                                            indexfcn(req, res, alertType, alertText);
                                        });
                                    })
                        })
                    .catch(e => {
                        console.log("Could not delete sensor with ID " + sensor + ", cause " + e);
                        indexfcn(req, res, 'failure', 'Internal error during sensor deletion!');
                    });
                } else {
                    indexfcn(req, res, 'failure', 'Operation not permitted!');
                }
            } else if(sensorAction.endsWith("_edit_btn")) {
                //Edit action requested
                var text="{}";
                sensor = sensorAction.replace("_edit_btn", "");
                
                //Get sensor object from db, convert it to text and pass it to the /new_sensor page
                db.collection("sensors").findOne({ID: sensor}, {fields: {_id: 0, users: 0}})
                    .then(sensorobj => {
                        var configSchema = fs.readFileSync(__dirname + '/schemas/sensor_schema.json');
                        if(!isEmpty(sensorobj)) {
                            text = JSON.stringify(sensorobj, null, 2);
                        } 
                        res.render("pages/new_sensor", {message:"", text:text, schema:configSchema});
                    })
                    .catch(e => {
                        console.error('Could not load description for ' + sensor + ', cause ' + e.message);
                        res.redirect('/index');
                    });
            } else if(sensorAction.endsWith("_deploy_btn")) {
                //Deploy action requested
                sensor = sensorAction.replace("_deploy_btn", "");
                //Get sensor and config from db, generate a node red flow and deploy it via Node-RED's rest-API
                var sensorobj = await db.collection("sensors").findOne({ID: sensor}, {fields: {_id: 0, users: 0}})
                    .catch(e => console.error('Could not find ' + sensor + ' in sensors, cause ' + e.message));
                if(sensorobj != undefined) { 
                    var configobj = await db.collection("configs").findOne({type: sensorobj.type, version: sensorobj.version}, {fields: {_id: 0}})
                        .catch(e => console.error('Could not find config for type: ' + sensorobj.type 
                        + ', version: ' + sensorobj.version  + ' in configs, cause ' + e.message));
                    flowObject = node_red_comm.flowObjectFromTemplate(sensorobj, configobj);
                    node_red_comm.deployFlowObject(flowObject, async function (success) {
                        alertType = success ? 'success':'failure';
                        alertText = '<strong>' + sensor + (success ? ' has been deployed successfully!': ' could not be deployed!') +'</strong>';
                        indexfcn(req, res, alertType, alertText);
                    });
                }
            } else {
                console.log("Error: unkown sensor action!");
            }
        });

        // 'share_sensor' post (from '/index')
        // expected request body: {sensorid: "a sensor's id (string)", username: "the username for the user to share with (string)"}
        app.post('/share_sensor', loginControl.ensureLoggedIn('/login'), async function(req,res) {
            console.log("Got request body: " + util.inspect(req.body));
            if(req.user.role == roles.admin || req.user.sensors.includes(req.body.sensorid)) {
                db.collection("sensors").update({ID: req.body.sensorid}, {"$addToSet": {users: req.body.username}})
                    .then(() => {
                        console.log("pushing " + req.body.sensorid + " to " + req.body.username + ".sensors");
                        db.collection("users").update({username: req.body.username}, {"$addToSet": {sensors: req.body.sensorid}})
                            .then(indexfcn(req, res, 'success', "Setting " + req.body.user + " as owner for " + req.body.sensorid + " was successful!" ))
                    })
                    .catch(e=> indexfcn(req, res, 'success', "Could not set " + req.body.user + " as owner for " + req.body.sensorid + ": " + e.message ));
            } else {
                indexfcn(req, res, 'failure', "Operation not permitted!" );
            }
        });

        // '/login' route
        app.get('/login', function(req,res) {
            var message = '';
            if(req.flash.message != undefined) {
                message = req.flash.message;
            }
            res.render('pages/login', {message: message});
        });

        // '/login' post, validation / authentication via passport
        app.post('/login', passport.authenticate('local', { successRedirect: '/', failureRedirect: '/login', failureFlash: true }));

        // '/logout' route, logout current user
        app.get('/logout', function(req, res){
            req.logout();
            res.redirect('/login');
        });

        // 'new_sensor' route
        app.get('/new_sensor', loginControl.ensureLoggedIn('/login'), function(req, res) {
            var configSchema = fs.readFileSync(__dirname + '/schemas/sensor_schema.json');
            res.render('pages/new_sensor', {message:"", text:"{}", schema:configSchema});
        });

        // '/new_sensor' post, 
        // expected request body: {text: "stringified JSON sensor representation"}
        app.post('/new_sensor', loginControl.ensureLoggedIn('/login'), async function(req, res) {
            console.log("Got data: " + util.inspect(req.body));
            var message = "";
            var sensor_valid = false;
            var configSchema = '';
            try {
                // Parse passed text into JSON object 
                jsonobj = JSON.parse(req.body.text);
                var validator = new JSONSchemaValidator();
                configSchema = fs.readFileSync(__dirname + '/schemas/sensor_schema.json');
                configSchemaJson = JSON.parse(configSchema);
                // Validate using jsonschema 
                var result = validator.validate(jsonobj, configSchemaJson);
                console.log(result);
                if (result.errors.length == 0) {
                    //custom validation -> type / version must be a valid configuration file
                    cfgs = await listcfgsfun();
                    console.log(jsonobj.type + ' in cfgs.objects ' + (jsonobj.type in cfgs.objects));
                    console.log(jsonobj.version + ' in ' + cfgs.objects[jsonobj.type] + ' ' + (cfgs.objects[jsonobj.type].indexOf(jsonobj.version) >= 0));
                    if(jsonobj.type in cfgs.objects && cfgs.objects[jsonobj.type].indexOf(jsonobj.version) >= 0) {
                        if(jsonobj.ID.indexOf(' ') > 0) {
                            message = "No spaces allowed in ID field!";
                        } else {
                            //Sensor is valid -> write sensor to db, update current user
                            sensor_valid = true;
                            db.collection("sensors").findOne({ID: jsonobj.ID})
                                .then(result => {
                                    if(!isEmpty(result))  {
                                        //Sensor already exists
                                        if(req.user.role == roles.admin || result.users.includes(req.user.username)) {
                                            //user is allowed to write -> update
                                            db.collection("sensors").updateOne({ID: jsonobj.ID}, {"$set": jsonobj}, {upsert: 1})
                                                .then(() => {
                                                    res.render('pages/new_sensor', {message: "Sensor update successful!", text:req.body.text, schema:configSchema});
                                                })
                                                .catch(e => console.error("Could not update sensor " + jsonobj.ID + ", cause: " + e.message));
                                        } else {
                                            res.render('pages/new_sensor', {message: "Sensor already exists and you are not permitted to change it.", text:req.body.text, schema:configSchema});
                                        }
                                    } else {
                                        //Sensor does not exist yet -> insert
                                        jsonobj.users = [req.user.username];
                                        db.collection("sensors").insertOne(jsonobj)
                                            .then(db.collection("users").updateOne({username: req.user.username}, {"$addToSet": {sensors: jsonobj.ID}}))
                                            .then(() => { 
                                                res.render('pages/new_sensor', {message: "Sensor creation successful!", text:req.body.text, schema:configSchema});
                                            })
                                            .catch(e => console.error("Could not create sensor " + jsonobj.ID + ", cause: " + e.message));
                                    }
                                })
                                .catch(e => console.error("Could not update sensor " + jsonobj.ID + ", cause: " + e.message));
                        }
                    } else {
                        message = "Type / version combination invalid!";
                    }
                } else {
                    message = "Validating JSON schema failed with result:\n" + result.errors[0];
                }
            } catch(err) {
                message = "Parsing sensor description failed with error message:\n" + err;
            }
            if(!sensor_valid) {
                res.render('pages/new_sensor', {message: message, text:req.body.text, schema:configSchema});
            }
        });

        /**
         * List all stored configuration object's type and version.
         * @return Promise({type: "first type to show in dropdown", 
         *              version: "first version to show in dropdown",
         *              objects: {"a type": ["version 1", ... , "version n"]} 
         *          })
         */
        var listcfgsfun = async function() {
            var cfgs = {};
            var type = "";
            var version = "";
            return new Promise((resolve, reject) => {
                db.collection("configs").aggregate([{
                    $group: {
                        _id: "$type",
                        versions: {$push: "$version"}
                    }   
                }]).toArray()
                    .then(aggregate => {
                        console.log("aggregation result: " + util.inspect(aggregate));
    
                        if(aggregate != undefined) {
                            for(i=0; i<aggregate.length; i++) {
                                cfgs[aggregate[i]._id] = aggregate[i].versions;
                            }
                        }
                        
                        if(Object.keys(cfgs).length > 0) {
                            type = Object.keys(cfgs)[0];
                            if(cfgs[type].length > 0) {
                                version = cfgs[type][0];
                            }
                        }
                        console.log("cfg.objects: " + util.inspect(cfgs) + ", cfg.type empty: " + (type == "") + ", cfg.version empty: " + (version == ""));
                        resolve( {type:type, version:version, objects:cfgs} );
                    })
                    .catch(e => reject(e));
            });
            
        };

        // '/new_config' route
        app.get('/new_config', loginControl.ensureLoggedIn('/login'), async function(req, res) {
            var configSchema = fs.readFileSync(__dirname + '/schemas/config_schema.json');
            var cfgs = await listcfgsfun();
            console.log("cfgs.type: " + cfgs.type);
            res.render('pages/new_configuration', {message:"", text:"{}", cfgs: cfgs, schema:configSchema});
        });

        // 'new_config' post,
        // expected request body: {text: "stringified JSON configuration representation"}
        app.post('/new_config', loginControl.ensureLoggedIn('/login'), async function(req, res) {
            // Post request is used for saving config to db -> expects res.render() call
            console.log("Got data: " + util.inspect(req.body));
            var cfg_valid = false;
            try {
                // Parse passed text into JSON object 
                jsonobj = JSON.parse(req.body.text);
                var validator = new JSONSchemaValidator();
                var configSchema = fs.readFileSync(__dirname + '/schemas/config_schema.json');
                var configSchemaJson = JSON.parse(configSchema);
                // Validate using jsonschema
                var result = validator.validate(jsonobj, configSchemaJson);
                if (result.errors.length == 0) {
                    //Custom validation steps
                    if(jsonobj.time.from == "field" && !(jsonbj.time.field in jsonobj.fields.map(field => field.name))) {
                        message = "Error: time.field does not match any field name in fields!";
                    } else if (jsonobj.time.from == "field" && 
                            !(('field' in jsonobj.time) && ('format' in jsonobj.time))) {
                        message = "Error: time.field and time.format are required when using time.from=\"field\"!";
                    } else {
                        dt_valid = true;
                        //Further custom validation for configobj.fields
                        for(i=0; i<jsonobj.fields.length; i++) {
                            if(jsonobj.fields[i].type in ['int', 'uint'] && !jsonobj.fields[i].length_bytes in [1,2,4]) {
                                message = "Error: integer types can only be 1,2 or 4 bytes long!";
                                dt_valid = false;
                                break;
                            } else if(jsonobj.fields[i].type == 'float' && !jsonobj.fields[i].length_bytes in [2,4,8]) {
                                message = "Error: floating types can only be 2, 4 or 8 bytes long!";
                                dt_valid = false;
                                break;
                            }
                        }
                        if(dt_valid) {
                            //Configuration is valid -> insert config into db
                            message = "";
                            cfg_valid = true;
                            console.log("Config is valid, prepare inserting!");
                            jsonobj.type = req.body.type;
                            jsonobj.version = req.body.version;
                            db.collection("configs").insertOne(jsonobj)
                                .then(() => {
                                    message = "Configuration was saved successfully!";
                                    listcfgsfun().then(cfgs => {
                                        cfgs.type = req.body.type;
                                        cfgs.version = req.body.version;
                                        res.render('pages/new_configuration', {message: message, text:req.body.text, cfgs:cfgs, schema:configSchema});
                                    })
                                    .catch(e => console.log("Could not get configs: " + e.message));
                                })
                                .catch(e => {
                                    message = "Could not update config " + req.body.type + ", " +  req.body.version + ", cause: " + e.message;
                                    listcfgsfun().then(cfgs => {
                                        res.render('pages/new_configuration', {message: message, text:req.body.text, cfgs:cfgs, schema:configSchema});
                                    })
                                    .catch(e => console.log("Could not get configs: " + e.message));
                                });
                        }
                    }
                } else {
                    message = "Validating JSON schema failed with result:\n" + result.errors[0];
                }
            } catch(err) {
                message = "Parsing sensor description failed with error message:\n" + err;
            }
            if(!cfg_valid) {
                console.log("Config is not valid, prepare rendering!");
                var cfgs = await listcfgsfun();
                cfgs.type = req.body.type;
                cfgs.version = req.body.version;
                res.render('pages/new_configuration', {message: message, text:req.body.text, cfgs:cfgs, schema:configSchema});
            }
        });

        // '/new_config' put,
        // expected request body: {type: "a type", version: "a version"}
        app.put('/new_config', loginControl.ensureLoggedIn('/login'), async function(req, res) {
            // Put request is used for requesting json description for type / version combination
            // -> expects res.send() call
            console.log("Got data: " + util.inspect(req.body));

            db.collection("configs").findOne({type: req.body.type, version: req.body.version}, {fields: {_id: 0, type: 0, version: 0}})
                .then(config => {
                    if(!isEmpty(config)) {
                        res.send(JSON.stringify(config, null, 2));
                    } else {
                        res.send('');
                    }
                })
                .catch(e => {
                    console.error("Could not find config" + req.body.type + ", " +  req.body.version + ", cause: " + e.message);
                    res.send('');
                });
        });

        // '/user_management' route
        // - List all users and allow: change of roles, generation of new passowrd, deletion
        // - Display form to add new user
        app.get('/user_management', loginControl.ensureLoggedIn('/login'), async function(req, res) {
            console.log("Calling user: " + util.inspect(req.user));
            if(req.user.role != "admin") {
                res.redirect('/');
            } else {

                db.collection("users").find({}, {fields: {_id:0}, sort:'username'}).toArray().then(users => {
                    var user_alert = {};
                    var add_user_alert = {alertType: "", alertText: ""};
                    var user_alert_string = req.flash('user_alert');
                    var add_user_alert_string = req.flash('add_user_alert');
                    console.log('User alert: ' + user_alert_string);
                    if(!isEmpty(user_alert_string)) {
                        user_alert = JSON.parse(user_alert_string);
                    }
                    if(!isEmpty(add_user_alert_string)) {
                        add_user_alert = JSON.parse(add_user_alert_string);
                    }
                    
                    // Set user alert if there is a matching one, otherwise empty string
                    for(i=0; i<users.length; i++) {
                        if(user_alert && user_alert.username == users[i].username) {
                            users[i].alertType = user_alert.alertType;
                            users[i].alertText = user_alert.alertText;
                            console.log("Setting alert for user: " + users[i].username);
                        } else {
                            users[i].alertType = "";
                            users[i].alertText = "";
                        }
                    }

                    var rolesArray = Object.values(roles);

                    res.render('pages/user_management', {users: users, roles: rolesArray, 
                        alertType: add_user_alert.alertType, alertText:add_user_alert.alertText});
                });

            }
        });

        // '/new_user' post (from '/user_management'),
        // expected request body: {username_edit: "a username", password_edit: "a new password"}
        app.post('/new_user', loginControl.ensureLoggedIn('/login'), async function(req, res) {
            if(req.user.role != "admin") {
                res.redirect('/');
            } else {
                console.log("Got request body: " + util.inspect(req.body));
                var newUsername = req.body.username_edit;
                var newPassword = req.body.password_edit;
                if(newUsername != "" && newPassword.length >= 8) {
                    db.collection("users").findOne({username: newUsername}).then(user => {
                        if(user) {
                            req.flash('add_user_alert', JSON.stringify({alertType:'failure', alertText:'Could not create user, user already exists'}));
                            res.redirect('/user_management');
                        } else {
                            db.collection("users").insert({username: newUsername, passwordHash: bcrypt.hashSync(newPassword, 10), 
                                role: "standarduser", sensors:[]})
                                    .then(req.flash('add_user_alert', JSON.stringify({alertType:"success", alertText:"Successfully created user " + newUsername})))
                                    .catch(e => req.flash('add_user_alert', JSON.stringify({alertType:"failure", alertText:"Cannot inser user" + newUsername + " in db: " + e.message})))
                                    .finally(res.redirect('/user_management'));
                        }
                    })
                } else {
                    req.flash('add_user_alert', JSON.stringify({alertType:'failure', alertText:'Username may not be empty and password must contain at least 8 characters!'}));
                    res.redirect('/user_management');
                }
            }
        });

        // '/save_role' post (from '/user_management'),
        // expected request body: {username: "a username", role: "a role"}
        app.post('/save_role', loginControl.ensureLoggedIn('/login'), async function(req, res) {
            if(req.user.role != roles.admin) {
                res.redirect('/');
            } else {
                console.log("Save role: Got request body: " + util.inspect(req.body));
                // Prevent adimin from demoting the last admin to standarduser
                db.collection("users").findOne({username: req.body.username}).then(dbuser => {
                    //Check if the current user is an admin and wants to demote a user
                    console.log(dbuser.role + ", " + req.body.role + ", " + (dbuser.role == roles.admin) + ", " + (req.body.role != roles.admin));
                    if(dbuser.role == roles.admin && req.body.role != roles.admin) {
                        db.collection("users").findOne({role: roles.admin, username: {"$ne": dbuser.username}}).then(otherAdmin => {
                            console.log("Other admin: " + util.inspect(otherAdmin));
                            if(isEmpty(otherAdmin)) {
                                req.flash('user_alert', JSON.stringify({username: req.body.username, alertType:"failure", alertText:"Cannot demote the only admin!"}));
                                res.redirect('/user_management');
                            } else {
                                db.collection("users").updateOne({username: req.body.username}, {"$set": {role: req.body.role}})
                                    .then(req.flash('user_alert', JSON.stringify({username:req.body.username, alertType:"success", alertText:"Updated role to " + req.body.role})))
                                    .catch(e => req.flash('user_alert', JSON.stringify({username: req.body.username, alertType:"failure", alertText:"Cannot update user in db: " + e.message})))
                                    .finally(res.redirect('/user_management'));
                            }
                        });
                    } else {
                        //Otherwise change user role without further checks
                        db.collection("users").updateOne({username: req.body.username}, {"$set": {role: req.body.role}})
                            .then(req.flash('user_alert', JSON.stringify({username:req.body.username, alertType:"success", alertText:"Updated role to " + req.body.role})))
                            .catch(e => req.flash('user_alert', JSON.stringify({username: req.body.username, alertType:"failure", alertText:"Cannot update user in db: " + e.message})))
                            .finally(res.redirect('/user_management'));
                    }
                })
                .catch(e => {
                    req.flash('user_alert', JSON.stringify({user: req.body.username, alertType:"failure", alertText:"Cannot access database: " + e.message}));
                    res.redirect('/user_management');
                }); 
            }
        });

        // '/set_password' post (from '/user_management'),
        // expected request body: {username: "a username", password: "a password"}
        app.post('/set_password', loginControl.ensureLoggedIn('/login'), async function(req, res) {
            if(req.user.role != roles.admin) {
                res.redirect('/');
            } else {
                console.log("Setting pw " + req.body.password + " for user " + req.body.username);
                db.collection("users").update({username: req.body.username}, {"$set": {passwordHash: bcrypt.hashSync(req.body.password, 10)}},
                    {upsert: false})
                        .then(req.flash('user_alert', JSON.stringify({username:req.body.username, alertType:"success", alertText:"Updated password to: '" + req.body.password + "'"})))
                        .catch(e => req.flash('user_alert', JSON.stringify({username: req.body.username, alertType:"failure", alertText:"Could not update password for " + req.body.username + ": " + e.message})))
                        .finally(res.redirect('/user_management'));
            }
        });

        // '/delete_user' post (from '/user_management'),
        // expected request body: {username: "a username"}
        app.post('/delete_user', loginControl.ensureLoggedIn('/login'), async function(req, res) {
            console.log("/delete_user: got request body: " + util.inspect(req.body));
            if(req.user.role == roles.admin && req.user.username != req.body.username) {
                //Cascading delete: remove user from all of its sensors, then delete userobject
                db.collection("users").findOne({username: req.body.username})
                    .then(userobj => {
                        db.collection("sensors").updateMany({ID: {"$in": userobj.sensors}}, {"$pull": {users: req.body.username}})
                            .then(db.collection("users").deleteOne({username: req.body.username}))
                                .then(() => {
                                    req.flash('add_user_alert', JSON.stringify({alertType:"success", alertText:"Successfully deleted user " + req.body.username}));
                                    res.redirect('/user_management');
                                })
                    })
                    .catch(e => {
                        console.log("Could not delete user " + req.body.username + ", cause " + e.message);
                        req.flash('add_user_alert', JSON.stringify({alertType:"failure", alertText:"Could not delete user " + req.body.username + ", cause " + e.message}));
                        res.redirect('/user_management');
                    });
            } else {
                req.flash('add_user_alert', JSON.stringify({alertType:"failure", alertText:"Operation not permitted!"}));
                res.redirect('/user_management');
            }
        });

        //Page not found
        app.get('*', function(req, res) {
            res.render('pages/404');
        });

        //Start server
        app.listen(port, async function(){
            console.log("Server started at port " + port);
        });

    })
    .catch(e => "Could not get session key: " + e.message);

})
.catch(e => "Could not connect to database: " + e.message);