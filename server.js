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

const app = express();

const hostname = '0.0.0.0';
const port = 3033;

const cfgpath = '/home/kuchen/sensors/configs/';
const sensorpath = '/home/kuchen/sensors/users/';

var JSONSchemaValidator = require('jsonschema').Validator;

const dburl = 'mongodb://127.0.0.1:27017/sensorconfigdb';
var dbrep = undefined;

async function db() {
    if(dbrep == undefined) {
        var client = await MongoClient.connect(dburl).catch(e => console.error("Could not connect to MongoDB at " + dburl + ", cause: " + e.message));
        dbrep = client.db('sensorconfigdb');
        console.log("Using database " + dbrep);
    }
    return dbrep;
}

db().then(db => {

    var session_secret_rep;
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
            //console.log("Got user: " + username + ", pw: " + password);
            db.collection("users").findOne({username: username}, function(err, user) {
                console.log("Got user: " + util.inspect(user));
                if(err) { console.error("Error during authentication: " + err); return callback(err); }
                if(!user) { console.log("Incorrect username"); return callback(null, false, {message: 'Incorrect username.'}); }
                if(!bcrypt.compareSync(password, user.passwordHash)) {
                    console.log("Incorrect password");
                    return callback(null, false, {message: 'Incorrect password.'});
                }
                return callback(null, user);
            });
        }
    ));

    passport.serializeUser(function(user, callback) {
        callback(null, user.username);
    });

    passport.deserializeUser(function(username, cb) {
        db.collection("users").findOne({username: username}, function(err, user) {
            if(err) { console.error("Cannot deserialize user: " + err.message); return cb(err); }
            console.log("deserialized user: " + util.inspect(user));
            cb(null, user);
        });
    })

    app.use(body_parser.urlencoded());
    app.use(body_parser.json());

    app.use(require('cookie-parser')());
    session_secret()
        .then(session_secret => {
            app.use(require('express-session')({ secret: session_secret, resave:false, saveUninitialized: false }));
            app.use(flash());
            app.use(passport.initialize());
            app.use(passport.session());

        // app.use(session({
        //     cookieName: 'session',
        //     secret: '',
        //     duration: 1000 * 3600 * 48,
        //     activeDuration: 1000 * 3600 * 24,
        // }));

        app.use('/vendor', express.static(__dirname + '/vendor'));
        app.use('/img', express.static(__dirname + '/img'));
        app.use('/schemas', express.static(__dirname + '/schemas'));
        // app.use('/css', express.static(__dirname + '/css'));
        // app.use('/js', express.static(__dirname + '/js'));
        // app.use('/scss', express.static(__dirname + '/scss'));

        app.set('view engine', 'ejs');

        /* Init all variables to default value */
        app.use(function (req, res, next) {
            res.locals.activepage = null;
            next();
        });

        var getAllSensorsFcn = async function() {
            return db.collection("sensors").find({}, {_id: 0}).toArray();
        }

        var indexfcn = async function(req, res) {
            var sensors = await getAllSensorsFcn().catch(e => console.error("Could not get sensors, cause: " + e.message));
            res.render('pages/index', {sensors: sensors, alertType:'', alertText:''});
        };

        app.get('/', loginControl.ensureLoggedIn('/login'), indexfcn);

        app.get('/index', loginControl.ensureLoggedIn('/login'), indexfcn);

        app.post('/index', loginControl.ensureLoggedIn('/login'), async function(req,res) {
            console.log("Got data: " + util.inspect(req.body));
            sensorAction = Object.keys(req.body)[0];
            if(sensorAction.endsWith("_delete_btn")) {
                //delete action
                console.log("Deleting: " + sensorAction.replace("_delete_btn", ""));
                sensor = sensorAction.replace("_delete_btn", "");
                //TODO delete mechanism with multiuser
                try {
                    await db.collection("sensors").deleteOne({ID: sensor});
                    node_red_comm.deleteFlowForSensorId(sensor, async function(success) {
                        alertType = success ? 'success':'failure';
                        alertText = '<strong>' + sensor + (success ? ' has been deleted successfully!': ' has dependent flows that could not be deleted. Please do that manually in Node-RED at port 1880!') +'</strong>';
                        var sensors = await getAllSensorsFcn().catch(e => console.error("Could not get sensors, cause: " + e.message));
                        res.render('pages/index', {sensors: sensors, alertType: alertType, alertText: alertText});
                    });
                } catch(e) {
                    console.log("Could not delete sensor with ID " + sensor + ", cause " + e);
                    var sensors = await getAllSensorsFcn().catch(e => console.error("Could not get sensors, cause: " + e.message));
                    res.render('pages/index', {sensors: sensors, alertType: 'failure', alertText: 'Sensor was not found on the system!'});
                }
            } else if(sensorAction.endsWith("_edit_btn")) {
                var text="{}";
                //edit action
                sensor = sensorAction.replace("_edit_btn", "");
                var sensorobj = db.collection("sensors").findOne({ID: sensor}, {_id: 0})
                    .catch(e => console.error('Could not find ' + sensor + ' in sensors, cause ' + e.message));
                if(sensorobj != undefined) {
                    text = JSON.stringify(sensorobj);
                }
                var configSchema = fs.readFileSync(__dirname + '/schemas/sensor_schema.json');
                res.render("pages/new_sensor", {message:"", text:text, schema:configSchema});
            } else if(sensorAction.endsWith("_deploy_btn")) {
                //edit action
                sensor = sensorAction.replace("_deploy_btn", "");
                var sensorobj = db.collection("sensors").findOne({ID: sensor}, {_id: 0})
                    .catch(e => console.error('Could not find ' + sensor + ' in sensors, cause ' + e.message));
                if(sensorobj != undefined) { 
                    var configobj = db.collection("configs").findOne({type: sensorobj.type, version: sensorobj.version}, {_id: 0})
                        .catch(e => console.error('Could not find config for type: ' + sensorobj.type 
                        + ', version: ' + sensorobj.version  + ' in configs, cause ' + e.message));
                    flowObject = node_red_comm.flowObjectFromTemplate(sensorobj, configobj);
                    // console.log('\n\n');
                    // console.log(JSON.stringify(flowObject, null, 2));
                    // console.log('\n\n');
                    node_red_comm.deployFlowObject(flowObject, async function (success) {
                        alertType = success ? 'success':'failure';
                        alertText = '<strong>' + sensor + (success ? ' has been deployed successfully!': ' could not be deployed!') +'</strong>';
                        var sensors = await getAllSensorsFcn().catch(e => console.error("Could not get sensors, cause: " + e.message));
                        res.render('pages/index', {sensors: sensors, alertType: alertType, alertText: alertText});
                    });
                }
                //res.redirect('/index');
            } else {
                console.log("Error: unkown sensor action!");
            }
        });

        app.get('/login', function(req,res) {
            var message = '';
            if(req.flash.message != undefined) {
                message = req.flash.message;
            }
            res.render('pages/login', {message: message});
        });

        app.post('/login', passport.authenticate('local', { successRedirect: '/', failureRedirect: '/login', failureFlash: true }));

        app.get('/new_sensor', loginControl.ensureLoggedIn('/login'), function(req, res) {
            var configSchema = fs.readFileSync(__dirname + '/schemas/sensor_schema.json');
            res.render('pages/new_sensor', {message:"", text:"{}", schema:configSchema});
        });

        app.post('/new_sensor', loginControl.ensureLoggedIn('/login'), async function(req, res) {
            console.log("Got data: " + util.inspect(req.body));
            var message = "";
            //TODO usermanagement
            var user = "cschwerin";
            var sensor_valid = false;
            var configSchema = '';
            try {
                jsonobj = JSON.parse(req.body.text);
                var validator = new JSONSchemaValidator();
                configSchema = fs.readFileSync(__dirname + '/schemas/sensor_schema.json');
                configSchemaJson = JSON.parse(configSchema);
                //validate
                var result = validator.validate(jsonobj, configSchemaJson);
                console.log(result);
                if (result.errors.length == 0) {
                    //custom validation -> type / version must be a valid configuration file
                    cfgs = listcfgsfun();
                    console.log(jsonobj.type + ' in cfgs.objects ' + (jsonobj.type in cfgs.objects));
                    console.log(jsonobj.version + ' in ' + cfgs.objects[jsonobj.type] + ' ' + (cfgs.objects[jsonobj.type].indexOf(jsonobj.version) >= 0));
                    if(jsonobj.type in cfgs.objects && cfgs.objects[jsonobj.type].indexOf(jsonobj.version) >= 0) {
                        sensor_valid = true;
                        //TODO check if exists
                        db.collection("sensors").updateOne({ID: jsonobj.ID}, {"$set": jsonobj}, {upsert: 1})
                            .catch(e => console.error("Could not get update sensor" + jsnobj.ID + ", cause: " + e.message));
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
            } else {
                res.render('pages/new_sensor', {message: "Sensor creation successful!", text:req.body.text, schema:configSchema});
            }
        });

        var listcfgsfun = async function() {
            var cfgs = {};
            var type = "";
            var version = "";
            var aggregate = db.collection("configs").aggregate([{
                $group: {
                    _id: "$type",
                    versions: {$push: "$version"}
                }   
            }]).toArray().catch(e => console.error("Could not get configs, cause: " + e.message));
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
            return {type:type, version:version, objects:cfgs};
        };

        app.get('/new_config', loginControl.ensureLoggedIn('/login'), async function(req, res) {
            var configSchema = fs.readFileSync(__dirname + '/schemas/config_schema.json');
            var cfgs = await listcfgsfun();
            res.render('pages/new_configuration', {message:"", text:"{}", cfgs: cfgs, schema:configSchema});
        });

        app.post('/new_config', loginControl.ensureLoggedIn('/login'), async function(req, res) {
            // Post request is used for saving / replacing -> expects res.render() call
            console.log("Got data: " + util.inspect(req.body));
            var cfg_valid = false;
            var configSchemaPretty = '';
            try {
                jsonobj = JSON.parse(req.body.text);
                var validator = new JSONSchemaValidator();
                var configSchema = fs.readFileSync(__dirname + '/schemas/config_schema.json');
                var configSchemaJson = JSON.parse(configSchema);
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

                            message = "";
                            cfg_valid = true;
                            var typepath = cfgpath + req.body.type + "/";
                            db.collection("configs").updateOne({type: req.body.type, version: req.body.version}, {"$set": jsonobj}, {upsert: 1})
                                .catch(e => console.error("Could not update config" + req.body.type + ", " +  req.body.version + ", cause: " + e.message));
                        }
                    }
                } else {
                    message = "Validating JSON schema failed with result:\n" + result.errors[0];
                }
            } catch(err) {
                message = "Parsing sensor description failed with error message:\n" + err;
            }
            if(!cfg_valid) {
                var cfgs = await listcfgsfun();
                res.render('pages/new_configuration', {message: message, text:req.body.text, cfgs:cfgs, schema:configSchema});
            } else {
                var cfgs = await listcfgsfun();
                if(!(req.body.type in cfgs.objects)) {
                    cfgs.objects[req.body.type] = [];
                }
                if(!(req.body.version in cfgs.objects[req.body.type])) {
                    cfgs.objects[req.body.type].push(req.body.version);
                }
                cfgs.type = req.body.type;
                cfgs.version = req.body.version;
                res.render('pages/new_configuration', {message: "Configuration was saved successfully!", text:req.body.text, cfgs:cfgs, schema:configSchema});
            }
        
        });

        app.put('/new_config', loginControl.ensureLoggedIn('/login'), async function(req, res) {
            // Put request is used for requesting json description for type / version combination
            // -> expects res.send() call
            console.log("Got data: " + util.inspect(req.body));

            var jsonobj = db.collection("configs").findOne({type: req.body.type, version: req.body.version}, {_id: 0})
                .catch(e => console.error("Could not find config" + req.body.type + ", " +  req.body.version + ", cause: " + e.message));
            if(jsonobj != undefined) {
                jsonstr = JSON.stringify(jsonobj);
                res.send(jsonstr);
            } else {
                res.send('');
            }
        });

        app.get('/user_management', loginControl.ensureLoggedIn('/login'), async function(req, res) {
            console.log("Calling user: " + util.inspect(req.user));
            if(req.user.role != "admin") {
                res.redirect('/');
            } else {
                var testusers = [{username: "test", passwordHash:"123", role:"standarduser", sensors:["testsensor1", "testsensor_2_"], alertType:"success", alertText:"New password is 123"}];
                var testroles = ["admin", "standarduser"]
                res.render('pages/user_management', {users: testusers, roles: testroles, alertType: ""});
            }
        });

        app.get('*', function(req, res) {
            res.render('pages/404');
        });

        app.listen(port, async function(){
            console.log("Server started at port " + port);
        });

    })
    .catch(e => "Could not get session key: " + e.message);

})
.catch(e => "Could not connect to database: " + e.message);