/**
 * This module is responsible for communicating with the Node-RED server's rest-API running on
 * 127.0.0.1:1880. It provides functionality for automatically generating and 
 * deploying workflows for sensor data integration and storage.
 */

const http = require('http');
const url = require('url');
const fs = require('fs');

// Workflowtemplate
const templatepath = __dirname + '/schemas/nodered_sensordata_to_db.json.template'; 
// Config file - read and write
const cfgpath = __dirname + '/node-red-comm.cfg';

/**
 * Increment all ids by a fixed number so they are unique. It is assumed, that an id is
 * 14 or 15 characters long and contains a '.' at position 7 or 8.
 * @param target workflow object containing the ids to update
 * @param flownumber the number to increase each id by
 * @return updated target
 **/
var incidfn = function(target, flownumber) {
    //If target is an id string -> increment
    if(typeof(target) == "string" && (target.length == 14 || target.length == 15)
        && (target.indexOf(".")  == 7 ||  target.indexOf(".")  == 8)) {
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

/**
 * Build the javascript function to convert the raw message payload 
 * of a node red message (bytes) to a JSON representation using the
 * given sensor and configuration objects.
 * @param sensorobj sensorobject to generate the conversion function for
 * @param configobj configurationobject for the given sensor 
 * @return payload conversion function as string
 */
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

/**
 * Generate a node red flow object for a specific sensor using the template file.
 * @param sensorobj the sensorobject to generate the flow object for
 * @param configobj the configobject for the given sensor
 */
exports.flowObjectFromTemplate = function(sensorobj, configobj) {
    var template = JSON.parse(fs.readFileSync(templatepath));
    var flownumber = parseInt(fs.readFileSync(cfgpath)) + 1;
    var target = incidfn(template, flownumber);
    console.log("Template ids were incremented by " + flownumber);

    for (var key in target){
        if (target.hasOwnProperty(key)) {
            if(target[key].type == "tab") {
                target[key].label = sensorobj.ID;
            } else if(target[key].type == "ttn uplink") {
                target[key].dev_id = sensorobj.TTN.DevId;
            } else if(target[key].type == "ttn app") {
                target[key].appId = sensorobj.TTN.AppId;
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

/**
 * Update an already existing flow to a new version.
 * @param flowInfo an object containing the 'id' and 'label' of the flow to update
 * @param flowObject the flow object to update the flow with
 * @param success_callback processes a boolean indicating update success or failure
 */
var updateFlowFn = function(flowInfo, flowObject, success_callback) {
    var entrypoint = '/flow';
    var method = 'POST';
    var requestBody = {id: flowInfo.id, label: flowInfo.label};
    if(flowInfo.existing) {
        console.log("Using method PUT to update flow with id: " + flowInfo.id);
        for(i=0; i<flowObject.length; i++) {
            if(flowObject.z != '') {
                flowObject[i].z = flowInfo.id;
            }
        }
        entrypoint += '/' + flowInfo.id;
        method = 'PUT';
    }
    requestBody.nodes = flowObject;
    const postData = JSON.stringify(requestBody);
    const options = {
        host: '127.0.0.1', 
        port: 1880, 
        method: method,
        path: entrypoint,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    }
    const req = http.request(options, (res) => {
        console.log("Deploying flow response status code: " + res.statusCode);
        if(res.statusCode == 400) {
            var responseData = Buffer.alloc(0);     
            res.on('data', (chunk) => {
                responseData = Buffer.concat([responseData, chunk]);
            });
            res.on('end', () => {
                console.log('Error response: ' + responseData.toString());
            });
            success_callback(false);
        } else if(res.statusCode == 401) {
            console.log('Error: not authorized!');
            success_callback(false);
        } else if(res.statusCode == 204 || res.statusCode == 200) {
            success_callback(true);
        } else {
            console.log('Error: unexpected status code!');
            success_callback(false);
        }    
    });

    req.write(postData);
    req.end();
};

/**
 * Get a list of all existing flows from the local Node-RED server
 * and run the given callback on that list of flows.
 * @param callback a callback processing the list of local Node-RED flows 
 */
var runOnExistingFlows = function(callback) {
    //Get existing flows
    const listFlowsOptions = {
        host: '127.0.0.1',
        port: 1880,
        method: 'GET',
        path: '/flows',
        headers: {
            'Content-Type': 'application/json',
            'Connection': 'keep-alive'
        }
    }
    const listFlowsReq = http.request(listFlowsOptions, (res) => {
        console.log('List flows status code: ' + res.statusCode);
        console.log('List flows headers: ' + JSON.stringify(res.headers));
        if(res.statusCode == 401) {
            console.log('Error: Not authorized!');
            success_callback(false);
        } else if(res.statusCode == 400) {
            console.log('Error: invalid API version!');
            success_callback(false);
        } else if(res.statusCode == 200) {
            //success
            var responseData = Buffer.alloc(0);     
            res.on('data', (chunk) => {
                responseData = Buffer.concat([responseData, chunk]);
            });
            res.on('end', () => {
                var flows = JSON.parse(responseData);
                callback(flows);
            });
        } else {
            console.log('Error: unexpected status code!');
            success_callback(false);
        }      
    });
    listFlowsReq.end();
}

/**
 * Deploy the given flow object on the local Node-RED server.
 * @param flowObject the flow object to deploy
 * @param success_callback processes a boolean indicating deployment success or failure
 */
exports.deployFlowObject = function(flowObject, success_callback) {
    
    var flowInfo = null;
    for(i=0; i<flowObject.length; i++) {
        if(flowObject[i].type == 'tab') {
            flowInfo = {label: flowObject[i].label, id: flowObject[i].id, existing: false};
            flowObject.splice(i,1);
            break;
        }
    }
    if(!flowInfo) {
        console.log('Error: could not extract flow info, malformed flow object!');
        success_callback(false);
        return;
    }

    runOnExistingFlows((flows) => {
        for(i=0; i<flows.length; i++) {
            if(flows[i].type == 'tab' && flows[i].label == flowInfo.label) {
                //Found active flow for current flow object -> replace
                flowInfo.id = flows[i].id;
                flowInfo.existing = true;
                console.log("Found id: " + flowInfo.id);
                break;
            }
        }
        updateFlowFn(flowInfo, flowObject, success_callback);
    });
}

/**
 * Delete the node red flow for a given sensor.
 * @param sensorid the id of the sensor whos flow should be deleted
 * @param success_callback processes a boolean indicating deletion success or failure
 *                          (also true if flow was not present)
 */
exports.deleteFlowForSensorId = function(sensorid, success_callback) {
    runOnExistingFlows((flows) => {
        var id = null;
        for(i=0; i<flows.length; i++) {
            if(flows[i].type == 'tab' && flows[i].label == sensorid) {
                //Found active flow for current flow object -> replace
                id = flows[i].id;
                console.log("Found id " +  id + " for " + sensorid);
                break;
            }
        }
        if(id) {
            const options = {
                host: '127.0.0.1', 
                port: 1880, 
                method: 'DELETE',
                path: '/flow/' + id,
            }
            const req = http.request(options, (res) => {
                console.log("Deleting flow response status code: " + res.statusCode);
                if(res.statusCode == 400) {
                    var responseData = Buffer.alloc(0);     
                    res.on('data', (chunk) => {
                        responseData = Buffer.concat([responseData, chunk]);
                    });
                    res.on('end', () => {
                        console.log('Error response: ' + responseData.toString());
                    });
                    success_callback(false);
                } else if(res.statusCode == 401) {
                    console.log('Error: not authorized!');
                    success_callback(false);
                } else if(res.statusCode == 404) {
                    console.log('Error: flow not found!');
                    success_callback(false);
                } else if(res.statusCode == 204 || res.statusCode == 200) {
                    success_callback(true);
                } else {
                    console.log('Error: unexpected status code!');
                    success_callback(false);
                }    
            });
            req.end();
        } else {
            console.log("No deployed flow for " + sensorid + " found, nothing to do!");
            success_callback(true);
        }
    });
};