const http = require('http');
const url = require('url');
const fs = require('fs');

const templatepath = __dirname + '/schemas/nodered_sensordata_to_db.json.template'; 
const cfgpath = __dirname + '/node-red-comm.cfg';

//Increment all ids by 1 so they are unique
var incidfn = function(target, flownumber) {
    //If target is an id object -> increment
    /*console.log('Target: ' + target + ', type: ' + typeof(target));
    if(typeof(target) == 'string') {
        console.log('Length: ' + target.length + ', pointpos: ' + target.indexOf("."));
    }*/
    if(typeof(target) == "string" && target.length == 15 
        && target.indexOf(".") == 8) {
        console.log('Incrementing id ' + target);
        var num = parseInt(target.substring(target.indexOf(".") + 1), 16);
        num += flownumber;
        target = target.substring(0,target.indexOf(".") + 1) + num.toString(16);
    }  
    //If target is an object -> check every attribute
    else if(typeof(target) == "object") {
        for (var key in target){
            if (target.hasOwnProperty(key)) {
                target[key] = incidfn(target[key], flownumber); 
            }
        }
    }
    //If target is an array -> check every item
    else if(typeof(target) == "array") {
        for (i=0; i<target.length; i++){
            target[i] = incidfn(target[i], flownumber); 
        }
    }

    return target;
}

var buildconversionfn = function(sensorobj, configobj) {
    var out = `var toArrayBuffer = function (buf) {
        var ab = new ArrayBuffer(buf.length);
        var view = new Uint8Array(ab);
        for (var i = 0; i < buf.length; ++i) {
            view[i] = buf[i];
        }
        return ab;
    }
    
    var toHalf = function( slice ) {
            var int16View = new Int16Array(toArrayBuffer(slice));
            var supportArray = new Int32Array(3);
            supportArray[0] = int16View[0] & 0x7fff; // Non-sign bits
            supportArray[1] = int16View[0] & 0x8000; // Sign bit
            supportArray[2] = int16View[0] & 0x7c00; // Exponent
    
            supportArray[0] = supportArray[0] << 13; // Align mantissa on MSB
            supportArray[1] = supportArray[1] << 16; // Shift sign bit into position
    
            supportArray[0] += 0x38000000; // Adjust bias
    
            supportArray[0] = (supportArray[2] == 0 ? 0 : supportArray[0]); //Denormals-as-zero
            supportArray[0] = supportArray[0] | supportArray[1]; //Re-insert sign bit
    
            console.log("Int16val: " + buf2hex(int16View.buffer));
            console.log("Support Array: " + buf2hex(supportArray.buffer));
    
            var floatView = new Float32Array(supportArray.buffer);
            return floatView[0];
    }
    
    `;
    out += 'var buf = msg.payload_raw;\n';
    out += 'var fields = {};\n';
    for(i=0; i<configobj.fields.length; i++) {
        var field = configobj.fields[i];
        if(field.type == 'int') {
            if(field.length_bytes == 1) {
                out += 'fields["' + field.name + '"] = buf.readInt8(' + field.offset_bytes + ');\n';
            } else {
                out += 'fields["' + field.name + '"] = buf.readInt' + (8 * field.length_bytes) + 'LE(' + field.offset_bytes + ');\n';
            }
        } else if(field.type == 'uint') {
            if(field.length_bytes == 1) {
                out += 'fields["' + field.name + '"] = buf.readUInt8(' + field.offset_bytes + ');\n';
            } else {
                out += 'fields["' + field.name + '"] = buf.readUInt' + (8 * field.length_bytes) + 'LE(' + field.offset_bytes + ');\n';
            } 
        } else if(field.type == 'float') {
            if(field.length_bytes == 2) {
                out += 'fields["' + field.name + '"] = toHalf(buf.slice(' + field.offset_bytes 
                    + ',' + (field.offset_bytes + field.length_bytes) + '));\n';
            } else if(field.length_bytes == 4) {
                out += 'fields["' + field.name + '"] = buf.readFloatLE(' + field.offset_bytes + ');\n';
            } else {
                out += 'fields["' + field.name + '"] = buf.readDoubleLE(' + field.offset_bytes + ');\n';
            }
        } else if(field.type in ['string', 'string_ascii'] ) {
            out += 'fields["' + field.name + '"] = buf.toString("ascii", ' + field.offset_bytes 
                + ', ' + (field.offset_bytes + field.length_bytes) +  ');\n';
        } else if(field.type == 'string_unicode' ) {
            out += 'fields["' + field.name + '"] = buf.toString("utf-8", ' + field.offset_bytes 
                + ', ' + (field.offset_bytes + field.length_bytes) +  ');\n';
        }
    }
    if(!('tags' in sensorobj)) {
        var tags = {};
    } else {
        var tags = sensorobj.tags;
    }
    tags['ID'] = sensorobj.ID;
    if(configobj.time.from == 'network') {
        tags['measuretime'] = 'network';
        out += 'fields["time"] = new Date().getTime() * 1000 * 1000;\n';
    } else {
        tags['measuretime'] = 'device';
        if(configobj.time.format == 'epoch_ns') {
            'fields["time"] = fields["' + configobj.time.field +  '"];\n';
        } else if(configobj.time.format == 'epoch_ms') {
            'fields["time"] = fields["' + configobj.time.field +  '"] * 1000;\n';
        } else if(configobj.time.format == 'epoch_s') {
            'fields["time"] = fields["' + configobj.time.field +  '"] * 1000 * 1000;\n';
        } else {
            'fields["time"] = Date.parse(fields["' + configobj.time.field +  '"]) * 1000 * 1000;\n';
        }
    }
    out += 'msg.payload = [fields,' + JSON.stringify(tags) + '];\n'
    out += 'return msg;' 
    return out;
}

exports.flowObjectFromTemplate = function(sensorobj, configobj) {
    var template = JSON.parse(fs.readFileSync(templatepath));
    var flownumber = parseInt(fs.readFileSync(cfgpath)) + 1;
    var target = incidfn(template, flownumber);

    for (var key in target){
        if (target.hasOwnProperty(key)) {
            if(target[key].type == "tab") {
                target[key].label = sensorobj.ID;
            } else if(target[key].type == "ttn uplink") {
                target[key].dev_id = sensorobj.TTN.DevId;
            } else if(target[key].type == "ttn app") {
                target[key].appID = sensorobj.TTN.AppId;
                target[key].accessKey = sensorobj.TTN.AccessKey;
            } else if(target[key].type == "function") {
                target[key].func = buildconversionfn(sensorobj, configobj);
            } else if(target[key].type == "influxdb out") {
                target[key].measurement = configobj.db.measurement;
            }
        }
    }

    //Success, save cfg
    fs.writeFileSync(cfgpath, flownumber.toString());

    return target;
}