var {URL, URLConnection, HttpCookie, HttpURLConnection} = java.net;
var {InputStream, BufferedOutputStream, OutputStreamWriter, BufferedWriter} = java.io;
var {GZIPInputStream, InflaterInputStream} = java.util.zip;
var {TextStream, MemoryStream} = require("io");
var {getMimeParameter, Headers, urlEncode} = require('ringo/utils/http');
var {ByteArray} = require("binary");
var objects = require("ringo/utils/objects");
var base64 = require("ringo/base64");

export("request", "get", "post", "put", "del");

const VERSION = "0.1";

var noop = function() {};

/**
 * Defaults for options passable to to request()
 */
var prepareOptions = function(options) {
    var defaultValues = {
        "data": {},
        "headers": {},
        "method": "GET",
        "username": undefined,
        "password": undefined,
        "followRedirects": true,
        "binary": false
    };
    var opts = options ? objects.merge(options, defaultValues) : defaultValues;
    Headers(opts.headers);
    opts.contentType = opts.contentType
            || opts.headers.get("Content-Type")
            || "application/x-www-form-urlencoded;charset=utf-8";
    return opts;
};

/**
 * Of the 4 arguments to get/post all but the first (url) are optional.
 * This fn puts the right arguments - depending on their type - into the options object
 * which can be used to call request()
 * @param {Array} Arguments Array
 * @returns {Object<{url, data, success, error}>} Object holding attributes for call to request()
 */
var extractOptionalArguments = function(args) {

    var types = [];
    for each (var arg in args) {
        types.push(typeof(arg));
    }

    if (types[0] != 'string') {
        throw new Error('first argument (url) must be string');
    }

    if (args.length == 1) {
        return {
            url: args[0]
        };

    } else if (args.length == 2) {
        if (types[1] == 'function') {
            return {
                url: args[0],
                success: args[1]
            };
        } else {
            return {
                url: args[0],
                data: args[1]
            };
        }
        throw new Error('two argument form must be (url, success) or (url, data)');
    } else if (args.length == 3) {
        if (types[1] == 'function' && types[2] == 'function') {
            return {
                url: args[0],
                success: args[1],
                error: args[2]
            };
        } else if (types[1] == 'object' && types[2] == 'function') {
            return {
                url: args[0],
                data: args[1],
                success: args[2]
            };
        } else {
            throw new Error('three argument form must be (url, success, error) or (url, data, success)');
        }
    }
    throw new Error('unknown arguments');
};

/**
 * A wrapper around java.net.HttpCookie
 * @param {java.net.HttpCookie} httpCookie The HttpCookie instance to wrap
 */
var Cookie = function(httpCookie) {

    Object.defineProperties(this, {
        /**
         * @returns {String} the cookie's name
         */
        name: {
            get: function() {
                return httpCookie.getName();
            }
        },
        /**
         * @returns {String} the cookie value
         */
        value: {
            get: function() {
                return httpCookie.getValue();
            }
        },
        /**
         * @returns {String} the cookie domain
         */
        domain: {
            get: function() {
                return httpCookie.getDomain();
            }
        },
        /**
         * @returns {String} the cookie path
         */
        path: {
            get: function() {
                return httpCookie.getPath();
            }
        },

        /**
         * @returns {Number} the max age of this cookie in seconds
         */
        "maxAge": {
            "get": function() {
                return httpCookie.getMaxAge();
            }
        },

        /**
         * @returns {String} true if this cookie is restricted to a secure protocol
         */
        "isSecure": {
            "get": function() {
                return httpCookie.getSecure();
            }
        },

        /**
         * @returns {String} the cookie version
         */
        "version": {
            "get": function() {
                return httpCookie.getVersion();
            }
        }
    });

    return this;
};

/**
 * @class Exchange instances represent a Http request and response
 * @param {String} url The URL
 * @param {Object} options The options
 * @param {Object} callbacks An object containing success, error and complete
 * callback methods
 * @returns A newly constructed Exchange instance
 * @constructor
 */
var Exchange = function(url, options, callbacks) {
    var reqData = options.data;
    var connection = null;
    var responseContent;
    var responseContentBytes;
    var isDone = false;

    Object.defineProperties(this, {
        /**
         * The connection used by this Exchange instance
         * @name Exchange.prototype.connection
         */
        "connection": {
            "get": function() {
                return connection;
            }, "enumerable": true
        },
        /**
         * True if the request has completed, false otherwise
         * @name Exchange.prototype.done
         */
        "done": {
            "get": function() {
                return isDone;
            }, enumerable: true
        },
        /**
         * The response body as String
         * @name Exchange.prototype.content
         */
        "content": {
            "get": function() {
                if (responseContent !== undefined) {
                    return responseContent;
                }
                return responseContent = this.contentBytes.decodeToString(this.encoding);
            }, "enumerable": true
        },
        /**
         * The response body as ByteArray
         * @name Exchange.prototype.contentBytes
         */
        "contentBytes": {
            "get": function() {
                if (responseContentBytes !== undefined) {
                    return responseContentBytes;
                }
                try {
                    responseContentBytes = new ByteArray(this.contentLength);
                    this.contentStream.readInto(responseContentBytes);
                    return responseContentBytes;
                } finally {
                    this.contentStream && this.contentStream.close();
                }
            }, "enumerable": true
        }
    });

    var outStream = null;
    try {
        if (options.method !== "POST" && options.method !== "PUT") {
            reqData = urlEncode(reqData);
            if (typeof(reqData) === "string" && reqData.length > 0) {
                url += "?" + reqData;
            }
        }
        connection = (new URL(url)).openConnection();
        connection.setAllowUserInteraction(false);
        connection.setFollowRedirects(options.followRedirects);
        connection.setRequestMethod(options.method);
        connection.setRequestProperty("User-Agent", "RingoJS HttpClient " + VERSION);
        connection.setRequestProperty("Accept-Encoding", "gzip,deflate");

        // deal with username:password in url
        var userInfo = connection.getURL().getUserInfo();
        if (userInfo) {
            var [username, password] = userInfo.split(":");
            options.username = options.username || username;
            options.password = options.password || password;
        }
        // set authentication header
        if (typeof(options.username) === "string" && typeof(options.password) === "string") {
            var authKey = base64.encode(options.username + ':' + options.password);
            connection.setRequestProperty("Authorization", "Basic " + authKey);
        }
        // set header keys specified in options
        for (let key in options.headers) {
            connection.setRequestProperty(key, options.headers[key]);
        }

        if (options.method === "POST" || options.method === "PUT") {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", options.contentType);
            outStream = new Stream(connection.getOutputStream());
            if (reqData instanceof InputStream) {
                (new Stream(reqData)).copy(outStream).close();
            } else if (reqData instanceof Binary) {
                (new MemoryStream(reqData)).copy(outStream).close();
            } else if (reqData instanceof Stream) {
                reqData.copy(outStream).close();
            } else {
                if (reqData instanceof TextStream) {
                    reqData = reqData.read();
                } else if (reqData instanceof Object) {
                    reqData = urlEncode(reqData);
                }
                if (typeof(reqData) === "string" && reqData.length > 0) {
                    var charset = getMimeParameter(options.contentType, "charset") || "utf-8";
                    var writer = new BufferedWriter(OutputStreamWriter(outStream, charset));
                    writer.write(reqData);
                    writer.close();
                }
            }
        }
        if (this.status > 300) {
            throw new Error(this.status);
        }
        var content = options.binary ? this.contentBytes : this.content;
        callbacks.success(content, this.status, this.contentType, this);
    } catch (e) {
        callbacks.error(this.message, this.status, this);
    } finally {
        isDone = true;
        try {
            var content = options.binary ? this.contentBytes : this.content;
            callbacks.complete(content, this.status, this.contentType, this);
        } finally {
            outStream && outStream.close();
            connection && connection.disconnect();
        }
    }

    return this;
};

Object.defineProperties(Exchange.prototype, {
    "url": {
        "get": function() {
            return this.connection.getURL();
        }, "enumerable": true
    },
    "status": {
        "get": function() {
            return this.connection.getResponseCode();
        }, "enumerable": true
    },
    "message": {
        "get": function() {
            return this.connection.getResponseMessage();
        }, "enumerable": true
    },
    /**
     * The response headers
     * @name Exchange.prototype.headers
     */
    "headers": {
        "get": function() {
            return new ScriptableMap(this.connection.getHeaderFields());
        }, enumerable: true
    },
    /**
     * The cookies set by the server
     * @name Exchange.prototype.cookies
     */
    "cookies": {
        "get": function() {
            var cookies = {};
            var cookieHeaders = this.connection.getHeaderField("Set-Cookie");
            if (cookieHeaders !== null) {
                var list = new ScriptableList(HttpCookie.parse(cookieHeaders));
                for each (let httpCookie in list) {
                    let cookie = new Cookie(httpCookie);
                    cookies[cookie.name] = cookie;
                }
            }
            return cookies;
        }, enumerable: true
    },
    /**
     * The response encoding
     * @name Exchange.prototype.encoding
     */
    "encoding": {
        "get": function() {
            return getMimeParameter(this.contentType, "charset") || "utf-8";
        }, "enumerable": true
    },
    /**
     * The response content type
     * @name Exchange.prototype.contentType
     */
    "contentType": {
        "get": function() {
            return this.connection.getContentType();
        }, "enumerable": true
    },
    /**
     * The response content length
     * @name Exchange.prototype.contentLength
     */
    "contentLength": {
        "get": function() {
            return this.connection.getContentLength();
        }, "enumerable": true
    },
    /**
     * The response body as stream
     * @name Exchange.prototype.contentStream
     */
    "contentStream": {
        "get": function() {
            var inStream = this.connection[(this.status >= 200 && this.status < 400) ?
                    "getInputStream" : "getErrorStream"]();
            var encoding = this.connection.getContentEncoding();
            if (encoding != null) {
                encoding = encoding.toLowerCase();
                if (encoding === "gzip") {
                    inStream = new GZIPInputStream(inStream);
                } else if (encoding === "deflate") {
                    inStream = new InflaterInputStream(inStream);
                }
            }
            return new Stream(inStream);
        }
    }
});

/**
 * Make a generic request.
 *
 * #### Generic request options
 *
 *  The `options` object may contain the following properties:
 *
 *  - `url`: the request URL
 *  - `method`: request method such as GET or POST
 *  - `data`: request data as string, object, or, for POST or PUT requests,
 *     Stream or Binary.
 *  - `headers`: request headers
 *  - `username`: username for HTTP authentication
 *  - `password`: password for HTTP authentication
 *  - `contentType`: the contentType
 *  - `binary`: if true if content should be delivered as binary,
 *     else it will be decoded to string
 *
 *  #### Callbacks
 *
 *  The `options` object may also contain the following callback functions:
 *
 *  - `complete`: called when the request is completed
 *  - `success`: called when the request is completed successfully
 *  - `error`: called when the request is completed with an error
 *  - `part`: called when a part of the response is available
 *  - `beforeSend`: called with the Exchange object as argument before the request is sent
 *
 *  The following arguments are passed to the `complete`, `success` and `part` callbacks:
 *  1. `content`: the content as String or ByteString
 *  2. `status`: the HTTP status code
 *  3. `contentType`: the content type
 *  4. `exchange`: the exchange object
 *
 *  The following arguments are passed to the `error` callback:
 *  1. `message`: the error message. This is either the message from an exception thrown
 *     during request processing or an HTTP error message
 *  2. `status`: the HTTP status code. This is `0` if no response was received
 *  3. `exchange`: the exchange object
 *
 * @param {Object} options
 * @returns {Exchange} exchange object
 * @see #get
 * @see #post
 * @see #put
 * @see #del
 */
var request = function(options) {
    var opts = prepareOptions(options);
    return new Exchange(opts.url, {
        "method": opts.method,
        "data": opts.data,
        "headers": opts.headers,
        "username": opts.username,
        "password": opts.password,
        "contentType": opts.contentType,
        "followRedirects": opts.followRedirects,
        "binary": opts.binary
    }, {
        "success": opts.success || noop,
        "complete": opts.complete || noop,
        "error": opts.error || noop,
        "part": opts.part || noop
    });
};

/**
 * Creates an options object based on the arguments passed
 * @param {String} method The request method
 * @param {String} url The URL
 * @param {String|Object|Stream|Binary} data Optional data to send to the server
 * @param {Function} success Optional success callback
 * @param {Function} error Optional error callback
 * @returns An options object
 */
var createOptions = function(method, url, data, success, error) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (args.length < 4) {
        var {url, data, success, error} = extractOptionalArguments(args);
    }
    return {
        method: method,
        url: url,
        data: data,
        success: success,
        error: error
    };
};

/**
 * Executes a GET request
 * @param {String} url The URL
 * @param {Object|String} data The data to append as GET parameters to the URL
 * @param {Function} success Optional success callback
 * @param {Function} error Optional error callback
 * @returns The Exchange instance representing the request and response
 * @type Exchange
 */
var get = function(url, data, success, error) {
    return request(createOptions("GET", url, data, success, error));
};

/**
 * Executes a POST request
 * @param {String} url The URL
 * @param {Object|String|Stream|Binary} data The data to send to the server
 * @param {Function} success Optional success callback
 * @param {Function} error Optional error callback
 * @returns The Exchange instance representing the request and response
 * @type Exchange
 */
var post = function(url, data, success, error) {
    return request(createOptions("POST", url, data, success, error));
};

/**
 * Executes a DELETE request
 * @param {String} url The URL
 * @param {Object|String} data The data to append as GET parameters to the URL
 * @param {Function} success Optional success callback
 * @param {Function} error Optional error callback
 * @returns The Exchange instance representing the request and response
 * @type Exchange
 */
var del = function(url, data, success, error) {
    return request(createOptions("DELETE", url, data, success, error));
};

/**
 * Executes a PUT request
 * @param {String} url The URL
 * @param {Object|String|Stream|Binary} data The data send to the server
 * @param {Function} success Optional success callback
 * @param {Function} error Optional error callback
 * @returns The Exchange instance representing the request and response
 * @type Exchange
 */
var put = function(url, data, success, error) {
    return request(createOptions("PUT", url, data, success, error));
};