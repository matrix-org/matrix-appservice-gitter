"use strict";

function ProvisioningCommand(opts) {
    this._params = opts.params;
    this._func   = opts.func;
}

ProvisioningCommand.prototype.run = function(bridge, req, res) {
    var body = req.body;

    var args = [bridge, req, res];
    for (var i = 0; i < this._params.length; i++) {
        var param = this._params[i];

        if(!(param in body)) {
            res.status(400).json({error: "Required parameter " + param + " missing"});
            return;
        }

        args.push(body[param]);
    }

    this._func.apply(this, args);
};

var provisioning = {};

provisioning.getlink = new ProvisioningCommand({
    params: ["matrix_room_id"],
    func: function(bridge, req, res, matrixId) {
        bridge.getLinkByMatrixId(matrixId).then(
            (link) => {
                if (!link) {
                    res.status(404).json({error: 'Link not found.'});
                } else {
                    res.json(link)
                }
            },
            (err)  => { res.status(500).json({error: err}) }
        );
    }
});

provisioning.link = new ProvisioningCommand({
    params: ["matrix_room_id", "remote_room_name"],
    func: function(bridge, req, res, matrixId, gitterName) {
        bridge.actionLink(matrixId, gitterName).then(
            ()    => { res.json({}) },
            (err) => { res.status(500).json({error: err}) }
        );
    },
});

provisioning.unlink = new ProvisioningCommand({
    params: ["matrix_room_id", "remote_room_name"],
    func: function(bridge, req, res, matrixId, gitterName) {
        bridge.actionUnlink(matrixId, gitterName).then(
            ()    => { res.json({}) },
            (err) => { res.status(500).json({error: err}) }
        );
    },
});

function handle(bridge, verb, req, res) {
    var prov = provisioning[verb];

    if (prov) {
        try {
            prov.run(bridge, req, res);
        }
        catch (e) {
            res.status(500).json({error: "Provisioning command failed " + e});
        }
    }
    else {
        res.status(404).json({error: "Unrecognised provisioning command " + verb});
    }
};

module.exports = {
    handle: handle,
};
