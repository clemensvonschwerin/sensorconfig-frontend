var toArrayBuffer = function (buf) {
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
