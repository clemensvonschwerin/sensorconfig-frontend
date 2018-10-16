const http = require('http');
const url = require('url');
const fs = require('fs');
const express = require('express');
const path = require('path');
const icons = require('glyphicons');
const body_parser = require('body-parser');
const util = require('util');
const session = require('client-sessions');

const app = express();

const hostname = '0.0.0.0';
const port = 3033;

const cfgpath = '/home/kuchen/sensors/configs/';
const sensorpath = '/home/kuchen/sensors/users/';

var JSONSchemaValidator = require('jsonschema').Validator;

app.use(body_parser.urlencoded());
app.use(body_parser.json());

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

var indexfcn = function(req, res) {
    var sensors = [];
    var itempath;
    items = fs.readdirSync(sensorpath);
    for(var i=0; i<items.length; i++) {
        if(items[i] != '.' && items[i] != '..') {
            console.log("Checking user: " + items[i]);
            sensoritems = fs.readdirSync(sensorpath + items[i]);
            for(var j=0; j<sensoritems.length; j++) {
                if(sensoritems[j] != '.' && sensoritems[j] != '..') {
                    console.log("Checking sensor: " + sensoritems[j]);
                    itempath = sensorpath + items[i] + "/" + sensoritems[j];
                    jsonstr = fs.readFileSync(itempath);
                    if(jsonstr == undefined) {
                        console.log("Could not read " + itempath);
                    } else {
                        jsonobj = JSON.parse(jsonstr);
                        if(!('desc' in jsonobj)) {
                            jsonobj.desc = "";
                        }
                        sensors.push(jsonobj);
                    }
                }
            }
        }
    }
    console.log("Sensors: " + sensors.length);
    res.render('pages/index', {sensors:sensors});
};

app.get('/', indexfcn);

app.get('/index', indexfcn);

app.get('/new_sensor', function(req, res) {
    res.render('pages/new_sensor', {message:"", text:"{}"});
});

app.post('/new_sensor', function(req, res) {
    console.log("Got data: " + util.inspect(req.body));
    var message = "";
    //TODO usermanagement
    var user = "cschwerin";
    var sensor_valid = false;
    try {
        jsonobj = JSON.parse(req.body.text);
        //validate
        console.log("" + ('ID' in jsonobj) + " " + ('TTN' in jsonobj) + " " + ('type' in jsonobj)+ " " + ('version' in jsonobj));
        if(!('ID' in jsonobj) || !('TTN' in jsonobj) || !('type' in jsonobj) || !('version' in jsonobj)) {
            message = "Error: Not all required fields found in base object!";
        } else {
            if(!('DEVADDR' in jsonobj.TTN) || !('APPEUI' in jsonobj.TTN)) {
                message = "Error: Not all required fields found in TTN object!";
            } else {
                sensor_valid = true;
                //TODO check if exists
                fs.open(sensorpath + user + "/" + jsonobj.ID + ".json", 'w', (err, fd) => {
                    if (err) throw err;
                    fs.write(fd, req.body.text, (err, written, buffer) => {
                        fs.close(fd, (err)=> {
                            if (err) throw err;
                        });
                    });
                });
            }
        }
    } catch(err) {
        message = "Parsing sensor description failed with error message:\n" + err;
    }
    if(!sensor_valid) {
        res.render('pages/new_sensor', {message: message, text:req.body.text});
    } else {
        res.render('pages/index')
    }
});

var listcfgsfun = function() {
    var cfgs = {};
    var type = "";
    var version = "";
    typels = fs.readdirSync(cfgpath);
    for(var i=0; i<typels.length; i++) {
        if(typels[i] != '.' && typels[i] != '..') {
            versionls = fs.readdirSync(cfgpath + typels[i]);
            var versionnames = [];
            for(var j=0; j<versionls.length; j++) {
                if(versionls[j].endsWith('.json')) {
                    versionnames.push(versionls[j].substring(0,versionls[j].indexOf('.json')));
                }
            }
            cfgs[typels[i]] = versionnames;
        }
    }
    if(Object.keys(cfgs).length > 0) {
        type = Object.keys(cfgs)[0];
        if(cfgs[type].length > 0) {
            version = cfgs[type][0];
        }
    }
    console.log("cfgs.objects=" + util.inspect(cfgs));
    return {type:type, version:version, objects:cfgs};
};

app.get('/new_config', function(req, res) {
    res.render('pages/new_configuration', {message:"", text:"{}", cfgs:listcfgsfun()});
});

app.post('/new_config', function(req, res) {
    // Post request is used for saving / replacing -> expects res.render() call
    console.log("Got data: " + util.inspect(req.body));
    var cfg_valid = false;
    try {
        jsonobj = JSON.parse(req.body.text);
        var validator = new JSONSchemaValidator();
        var configSchema = fs.readFileSync(__dirname + '/schemas/config_schema.json');
        var result = validator.validate(jsonobj, configSchema);
        if (result.valid) {
            //Custom validation steps
            if(jsonobj.time.from == "field" && !(jsonbj.time.field in jsonobj.fields.map(field => field.name))) {
                message = "Error: time.field does not match any field name in fields!";
            } else if (jsonobj.time.from == "field" && 
                	!(('field' in jsonobj.time) && ('format' in jsonobj.time))) {
                message = "Error: time.field and time.format are required when using time.from=\"field\"!";
            } else {
                message = "";
                cfg_valid = true;
                var typepath = cfgpath + req.body.type + "/";
                if(!(fs.existsSync(typepath))) {
                    fs.mkdirSync(typepath);
                }

                //Save config
                fs.open(typepath + req.body.version + ".json", 'w', (err, fd) => {
                    if (err) throw err;
                    fs.write(fd, req.body.text, (err, written, buffer) => {
                        fs.close(fd, (err)=> {
                            if (err) throw err;
                        });
                    });
                });
            }
        } else {
            message = "Validating JSON schema failed with result:\n" + result.error;
        }
    } catch(err) {
        message = "Parsing sensor description failed with error message:\n" + err;
    }
    if(!cfg_valid) {
        res.render('pages/new_configuration', {message: message, text:req.body.text, cfgs:listcfgsfun()});
    } else {
        var cfgs = listcfgsfun();
        if(!(req.body.type in cfgs.objects)) {
            cfgs.objects[req.body.type] = [];
        }
        if(!(req.body.version in cfgs.objects[req.body.type])) {
            cfgs.objects[req.body.type].push(req.body.version);
        }
        cfgs.type = req.body.type;
        cfgs.version = req.body.version;
        res.render('pages/new_configuration', {message: "Configuration was saved successfully!", text:req.body.text, cfgs:cfgs});
    }
   
});

app.put('/new_config', function(req, res) {
    // Put request is used for requesting json description for type / version combination
    // -> expects res.send() call
    console.log("Got data: " + util.inspect(req.body));
    res.send('Test');
});

app.get('*', function(req, res) {
    res.render('pages/404');
});

app.listen(port, function(){
    console.log("Server started at port " + port);
});