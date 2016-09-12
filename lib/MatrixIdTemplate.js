"use strict";

function findFields(str) {
    var fields = [];

    // Scan the template looking for all the field names
    var re = /\${([^}]+)}/g;
    var result;
    while ((result = re.exec(str)) != null) {
        var field = result[1];

        if (fields.indexOf(field) !== -1) {
            throw new Error("Template field " + field + " appears multiple times");
        }
        fields.push(field);
    }

    return fields;
}

function escapeRegExp(string) {
    // https://developer.mozilla.org/en/docs/Web/JavaScript/Guide/Regular_Expressions
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function MatrixIdTemplate(sigil, str, domain) {
    this._sigil = sigil;
    this._str = str;
    this._domain = domain;
    this._fields = findFields(str);

    var re = str.replace(/\${[^}]+}/g, "(.*?)");

    this._localpartRe = new RegExp("^" + re + "$");
    this._idRe = new RegExp(
        "^" + escapeRegExp(sigil) + re + ":" + escapeRegExp(domain) + "$"
    );
}

MatrixIdTemplate.prototype.hasField = function(name) {
    return this._fields.indexOf(name) !== -1;
};

function execRe(str, re, fields) {
    var result = re.exec(str);
    if (!result) return null;

    var values = {};
    for (var idx = 0; idx < fields.length; idx++) {
        values[fields[idx]] = result[idx+1];
    }

    return values;
}

MatrixIdTemplate.prototype.matchLocalpart = function(str) {
    return execRe(str, this._localpartRe, this._fields);
};

MatrixIdTemplate.prototype.matchId = function(str) {
    return execRe(str, this._idRe, this._fields);
};

MatrixIdTemplate.prototype.expandLocalpart = function(fields) {
    var str = this._str;
    this._fields.forEach((n) => {
        if (!(n in fields)) {
            throw new Error("A value for " + n + " was not provided");
        }

        str = str.replace(new RegExp("\\${" + n + "}"), fields[n]);
    });
    return str;
};

MatrixIdTemplate.prototype.expandId = function(fields) {
    return this._sigil + this.expandLocalpart(fields) + ":" + this._domain;
};

module.exports = MatrixIdTemplate;
