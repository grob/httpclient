var assert = require("assert");
var {Server} = require("ringo/httpserver");
var response = require("ringo/jsgi/response");
var {request, post, get, put, del} = require("../lib/httpclient");
var {parseParameters, setCookie} = require("ringo/utils/http");
var strings = require("ringo/utils/strings");
var {MemoryStream, TextStream} = require("io");
var fs = require("fs");
var base64 = require("ringo/base64");

var server;
var host = "127.0.0.1";
var port = "8282";
var baseUri = "http://" + host + ":" + port + "/";

/**
 * tests overwrite getResponse() to control the response they expect back
 */
var getResponse;

/**
 * setUp pre every test
 */
exports.setUp = function() {
    var handleRequest = function(req) {
        req.charset = 'utf8';
        req.pathInfo = decodeURI(req.pathInfo);
        return getResponse(req);
    };

    server = new Server({
        host: host,
        port: port
    });
    server.getDefaultContext().serveApplication(handleRequest);
    server.start();
    // test used to hang without this, but seems no longer the case
    // java.lang.Thread.currentThread().sleep(1000);
};

/**
 * tearDown after each test
 */
exports.tearDown = function() {
    server.stop();
    server.destroy();
    server = null;
};

/**
 * test that callbacks get called at all; all other
 * tests rely on that.
 */
exports.testCallbacksGetCalled = function() {
    getResponse = function(req) {
        return response.html("<h1>This is the Response Text</h1>");
    };

    var beforeSendCalled, successCalled, completeCalled, errorCalled;
    request({
        "url": baseUri,
        "beforeSend": function(exchange) {
            beforeSendCalled = true;
        },
        "success": function(data, status, contentType, exchange) {
            successCalled = true;
        },
        "complete": function(data, status, contentType, exchange) {
            completeCalled = true;
        },
        "error": function(message, status, exchange) {
            errorCalled = true;
        }
    });
    assert.isTrue(beforeSendCalled);
    assert.isTrue(successCalled);
    assert.isTrue(completeCalled);
    assert.isUndefined(errorCalled);
};

/**
 * test basic get
 */
exports.testGet = function() {
    var text = "<h1>This is the Response Text</h1>";

    getResponse = function(req) {
        return response.html(text);
    };

    var errorCalled, myData;
    request({
        url: baseUri,
        success: function(data, status, contentType, exchange) {
            myData = data;
        },
        error: function() {
            errorCalled = true;
        }
    });
    assert.isUndefined(errorCalled);
    assert.strictEqual(myData, text);

    // get() convenience method
    var req = get(baseUri);
    assert.strictEqual(req.content, text);
};

/**
 * GET, POST params
 */
exports.testParams = function() {
    getResponse = function(req) {
        var params = {};
        var input = req.method == "POST" ? req.input.read() : req.queryString;
        parseParameters(input, params);
        return response.json(params);
    };
    var data = {
        a: "fääßß",
        b: "fööööbääzz",
        c: "08083",
        d: "0x0004"
    };
    var req = request({
        url: baseUri,
        method: 'GET',
        data: data
    });
    assert.strictEqual(200, req.status);
    assert.deepEqual(data, JSON.parse(req.content));

    req = request({
        url: baseUri,
        method: 'POST',
        data: data
    });
    assert.strictEqual(200, req.status);
    assert.deepEqual(data, JSON.parse(req.content));

    // post() convenience method
    req = post(baseUri, data);
    assert.deepEqual(JSON.parse(req.content), data);
};

exports.testPost = function() {

    getResponse = function(req) {
        var input;
        return {
            "status": 200,
            "headers": {
                "Content-Type": "application/octet-stream"
            },
            "body": {
                forEach: function(fn) {
                    var read, bufsize = 8192;
                    var buffer = new ByteArray(bufsize);
                    input = req.input;
                    while ((read = input.readInto(buffer)) > -1) {
                        buffer.length = read;
                        fn(buffer);
                        buffer.length = bufsize;
                    }
                },
                close: function() {
                    if (input) {
                        input.close();
                    }
                }
            }
        };
    };

    // use this module's source as test data
    var data = fs.read(module.path);
    var inputByteArray = data.toByteArray();

    // POSTing byte array
    var req = request({
        url: baseUri,
        method: "POST",
        data: inputByteArray
    });
    assert.strictEqual(200, req.status);
    assert.strictEqual(inputByteArray.length, req.contentBytes.length);
    assert.deepEqual(req.contentBytes.toArray(), inputByteArray.toArray());

    // POSTing memory stream
    req = request({
        url: baseUri,
        method: "POST",
        data: new MemoryStream(inputByteArray)
    });
    assert.strictEqual(200, req.status);
    assert.strictEqual(inputByteArray.length, req.contentBytes.length);
    assert.deepEqual(req.contentBytes.toArray(), inputByteArray.toArray());

    // POSTing text stream
    req = request({
        url: baseUri,
        method: "POST",
        data: new TextStream(new MemoryStream(data.toByteString()), {charset: "utf-8"})
    });
    assert.strictEqual(200, req.status);
    assert.strictEqual(inputByteArray.length, req.contentBytes.length);
    assert.deepEqual(req.contentBytes.toArray(), inputByteArray.toArray());

    // POSTing java.io.InputStream
    req = request({
        url: baseUri,
        method: "POST",
        data: fs.openRaw(module.path).unwrap()
    });
    assert.strictEqual(200, req.status);
    assert.strictEqual(inputByteArray.length, req.contentBytes.length);
    assert.deepEqual(req.contentBytes.toArray(), inputByteArray.toArray());

    var resource = getResource('./upload_test.png');
    var inputStream = resource.getInputStream();
    // small <1k file, just read it all in
    var size = resource.getLength();
    inputByteArray = new ByteArray(size);
    inputStream.read(inputByteArray, 0, size);
    var errorCalled;
    request({
        url: baseUri,
        method: "POST",
        data: resource.getInputStream(),
        error: function() {
            errorCalled = true;
        },
        complete: function(data, status, contentType, exchange) {
            req = exchange;
        }
    });
    assert.isUndefined(errorCalled);
    assert.strictEqual(inputByteArray.length, req.contentBytes.length);
    assert.deepEqual(inputByteArray.toArray(), req.contentBytes.toArray());
};

/**
 * send stream and get the same stream back
 */
exports.testStreamRequest = function() {

    getResponse = function(req) {
        var input;
        return {
            status: 200,
            headers: {
                'Content-Type': 'image/png'
            },
            body: {
                forEach: function(fn) {
                    var read, bufsize = 8192;
                    var buffer = new ByteArray(bufsize);
                    input = req.input;
                    while ((read = input.readInto(buffer)) > -1) {
                        buffer.length = read;
                        fn(buffer);
                        buffer.length = bufsize;
                    }
                },
                close: function() {
                    if (input) {
                        input.close();
                    }
                }
            }
        };
    };

    var resource = getResource('./upload_test.png');
    var ByteArray = require('binary').ByteArray;
    var inputStream = resource.getInputStream();
    // small <1k file, just read it all in
    var size = resource.getLength();
    var inputByteArray = new ByteArray(size);
    inputStream.read(inputByteArray, 0, size);
    var sendInputStream = resource.getInputStream();
    var myExchange, myContentType, errorCalled;
    request({
        url: baseUri,
        method: 'POST',
        data: sendInputStream,
        error: function() {
            errorCalled = true;
        },
        complete: function(data, status, contentType, exchange) {
            myExchange = exchange;
            myContentType = contentType;
        }
    });
    assert.isUndefined(errorCalled);
    assert.isNotNull(myExchange);
    assert.strictEqual (inputByteArray.length, myExchange.contentBytes.length);
    assert.deepEqual (inputByteArray.toArray(), myExchange.contentBytes.toArray());
    assert.strictEqual('image/png', myContentType);
};

/**
 * convenience wrappers
 */
exports.testConvenience = function() {
    getResponse = function(req) {
        var params = {};
        var input = req.method == "POST" ? req.input.read() : req.queryString;
        parseParameters(input, params);
        if (params.foo) {
            return response.html(req.method + " with param");
        }
        return response.html(req.method);
    };
    var x = post(baseUri);
    assert.strictEqual(200, x.status);
    assert.strictEqual(x.content, "POST");

    x = post(baseUri, {foo: 'bar'});
    assert.strictEqual(200, x.status);
    assert.strictEqual(x.content, "POST with param");

    x = get(baseUri, {foo: 'bar'});
    assert.strictEqual(200, x.status);
    assert.strictEqual(x.content, "GET with param");

    x = del(baseUri);
    assert.strictEqual(200, x.status);
    assert.strictEqual(x.content, "DELETE");

    x = put(baseUri);
    assert.strictEqual(200, x.status);
    assert.strictEqual(x.content, "PUT");
};

/**
 * test user info in url
 */
exports.testUserInfo = function() {

    var log;
    getResponse = function(req) {
        log.push(req.headers["authorization"]);
        return response.html("response text");
    };

    // username and password in url
    log = [];
    request({
        url: "http://user:pass@" + host + ":" + port + "/"
    });
    assert.equal(log.length, 1, "user:pass - one request");
    assert.equal(typeof log[0], "string", "user:pass - one Authorization header");
    assert.equal(log[0].slice(0, 5), "Basic", "user:pass - Basic auth header");

    // username only in url, password in options
    log = [];
    request({url: "http://user@" + host + ":" + port + "/", password: "pass"});
    assert.equal(log.length, 1, "user - one request");
    assert.equal(typeof log[0], "string", "user - one Authorization header");
    assert.equal(log[0].slice(0, 5), "Basic", "user - Basic auth header");

    // username and password in url, options take precedence
    log = [];
    request({url: "http://user:pass@" + host + ":" + port + "/", username: "realuser", password: "realpass"});
    assert.equal(log.length, 1, "precedence - one request");
    assert.equal(typeof log[0], "string", "precedence - one Authorization header");
    assert.equal(log[0], "Basic " + base64.encode("realuser:realpass"), "precedence - Basic auth header");
};

/**
 * Cookie set and read
 */
exports.testCookie = function() {
    var COOKIE_NAME = "testcookie"
    var COOKIE_VALUE = "cookie value with s p   a c es";
    var COOKIE_DAYS = 5;

    getResponse = function(req) {
        var params = {};
        parseParameters(req.queryString, params);
        // set cookie
        var res = response.html("cookie set");
        res.headers["Set-Cookie"] = setCookie(COOKIE_NAME,
                params.cookievalue, COOKIE_DAYS, {
                    "domain": "localhost",
                    "secure": true
                });
        return res;
    };

    // receive cookie
    var myStatus, myRequest, errorCalled;
    request({
        url: baseUri,
        method: "GET",
        data: {
            "cookievalue": COOKIE_VALUE
        },
        complete: function(data, status, contentType, request) {
            myStatus = status;
        },
        success: function(data, status, contentType, request) {
            myRequest = request;
        },
        error: function() {
            errorCalled = true;
        }
    });
    assert.isUndefined(errorCalled);
    assert.strictEqual(200, myStatus);
    var cookie = myRequest.cookies[COOKIE_NAME];
    assert.strictEqual(COOKIE_VALUE, cookie.value);
    // FIXME: why is -1 necessary?
    assert.strictEqual(cookie.maxAge, (5 * 24 * 60 * 60) - 1);
    assert.strictEqual(cookie.domain, "localhost");
    assert.strictEqual(cookie.isSecure, true);
};

/**
 * Callbacks
 */
exports.testCallbacks = function() {
    getResponse = function(req) {
        if (req.pathInfo == '/notfound') {
            return response.notFound('error');
        } else if (req.pathInfo == '/success') {
            return response.json('success');
        } else if (req.pathInfo == '/redirect') {
            return {
                status: 302,
                headers: {Location: '/redirectlocation'},
                body: ["Found: " + '/redirectlocation']
            };
        } else if (req.pathInfo == '/redirectlocation') {
            return response.html('redirect success');
        }
    };
    var myStatus, successCalled, errorCalled, myMessage, myContentType, myData;
    // success shouldn't get called
    var getErrorExchange = request({
        url: baseUri + 'notfound',
        method: 'GET',
        complete: function(data, status, contentType, exchange) {
            myStatus = status;
        },
        success: function() {
            successCalled = true
        },
        error: function(message, status, exchange) {
            myMessage = message;
        }
    });
    assert.isUndefined(successCalled);
    assert.strictEqual(myStatus, 404);
    assert.strictEqual(getErrorExchange.status, 404);
    assert.strictEqual(myMessage, "Not Found");

    var getSuccessExchange = request({
        url: baseUri + 'success',
        method: 'GET',
        complete: function(data, status, contentType, exchange) {
            myStatus = status;
        },
        success: function(data, status, contentType, exchange) {
            myContentType = contentType;
        },
        error: function() {
            errorCalled = true;
        }
    });
    assert.strictEqual('application/json; charset=utf-8', myContentType);
    assert.strictEqual(myStatus, 200);
    assert.isUndefined(errorCalled);

    var getRedirectExchange = request({
        url: baseUri + 'redirect',
        method: 'GET',
        complete: function(data, status, contentType, exchange) {
            myStatus = status;
            myData = data;
        },
        error: function(message) {
            errorCalled = true;
        }
    });
    assert.strictEqual(myStatus, 200);
    assert.strictEqual('redirect success', myData);
    assert.isUndefined(errorCalled);
};

// start the test runner if we're called directly from command line
if (require.main == module.id) {
    var {run} = require("test");
    if (system.args.length > 1) {
        system.exit(run(exports, system.args.pop()));
    }
    system.exit(run(exports));
}
