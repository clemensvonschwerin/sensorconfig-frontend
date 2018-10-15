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
    var sensorpath = '/home/kuchen/sensors/users/';
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
        jsonobj = JSON.parse(req.body.text)
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
                fs.open('/home/kuchen/sensors/users/' + user + "/" + jsonobj.ID + ".json", 'w', (err, fd) => {
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

app.get('/new_config', function(req, res) {
    res.render('pages/new_configuration', {message:"", text:"{}"});
});

app.get('*', function(req, res) {
    res.render('pages/404');
});

app.listen(port, function(){
    console.log("Server started at port " + port);
});