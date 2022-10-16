// This is the Edge Chat Demo Worker, built using Durable Objects!

// ===============================
// Introduction to Modules
// ===============================
//
// The first thing you might notice, if you are familiar with the Workers platform, is that this
// Worker is written differently from others you may have seen. It even has a different file
// extension. The `mjs` extension means this JavaScript is an ES Module, which, among other things,
// means it has imports and exports. Unlike other Workers, this code doesn't use
// `addEventListener("fetch", handler)` to register its main HTTP handler; instead, it _exports_
// a handler, as we'll see below.
//
// This is a new way of writing Workers that we expect to introduce more broadly in the future. We
// like this syntax because it is *composable*: You can take two workers written this way and
// merge them into one worker, by importing the two Workers' exported handlers yourself, and then
// exporting a new handler that call into the other Workers as appropriate.
//
// This new syntax is required when using Durable Objects, because your Durable Objects are
// implemented by classes, and those classes need to be exported. The new syntax can be used for
// writing regular Workers (without Durable Objects) too, but for now, you must be in the Durable
// Objects beta to be able to use the new syntax, while we work out the quirks.
//
// To see an example configuration for uploading module-based Workers, check out the wrangler.toml
// file or one of our Durable Object templates for Wrangler:
//   * https://github.com/cloudflare/durable-objects-template
//   * https://github.com/cloudflare/durable-objects-rollup-esm
//   * https://github.com/cloudflare/durable-objects-webpack-commonjs

// ===============================
// Required Environment
// ===============================
//
// This worker, when deployed, must be configured with two environment bindings:
// * rooms: A Durable Object namespace binding mapped to the ChatRoom class.
// * limiters: A Durable Object namespace binding mapped to the RateLimiter class.
//
// Incidentally, in pre-modules Workers syntax, "bindings" (like KV bindings, secrets, etc.)
// appeared in your script as global variables, but in the new modules syntax, this is no longer
// the case. Instead, bindings are now delivered in an "environment object" when an event handler
// (or Durable Object class constructor) is called. Look for the variable `env` below.
//
// We made this change, again, for composability: The global scope is global, but if you want to
// call into existing code that has different environment requirements, then you need to be able
// to pass the environment as a parameter instead.
//
// Once again, see the wrangler.toml file to understand how the environment is configured.

// =======================================================================================
// The regular Worker part...
//
// This section of the code implements a normal Worker that receives HTTP requests from external
// clients. This part is stateless.

// With the introduction of modules, we're experimenting with allowing text/data blobs to be
// uploaded and exposed as synthetic modules. In wrangler.toml we specify a rule that files ending
// in .html should be uploaded as "Data", equivalent to content-type `application/octet-stream`.
// So when we import it as `HTML` here, we get the HTML content as an `ArrayBuffer`. This lets us
// serve our app's static asset without relying on any separate storage. (However, the space
// available for assets served this way is very limited; larger sites should continue to use Workers
// KV to serve assets.)
import HTML from "./chat.html";
import { getAssetFromKV, mapRequestToAsset } from '@cloudflare/kv-asset-handler'
import manifestJSON from '__STATIC_CONTENT_MANIFEST'
const assetManifest = JSON.parse(manifestJSON)
import {zbencode, zbdecode} from "../public/encoding.mjs";

// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
// try/catch and return errors to the client. You probably wouldn't want to use this in production
// code but it is convenient when debugging and iterating.
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      // Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
      // won't show us the response body! So... let's send a WebSocket response with an error
      // frame instead.
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack}));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, {status: 500});
    }
  }
}

// In modules-syntax workers, we use `export default` to export our script's main event handlers.
// Here, we export one handler, `fetch`, for receiving HTTP requests. In pre-modules workers, the
// fetch handler was registered using `addEventHandler("fetch", event => { ... })`; this is just
// new syntax for essentially the same thing.
//
// `fetch` isn't the only handler. If your worker runs on a Cron schedule, it will receive calls
// to a handler named `scheduled`, which should be exported here in a similar way. We will be
// adding other handlers for other types of events over time.
export default {
  async fetch(request, env, ctx) {
    return await handleErrors(request, async () => {
      // We have received an HTTP request! Parse the URL and route the request.

      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        // Serve our HTML at the root path.
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      }

      switch (path[0]) {
        case "api":
          // This is a request for `/api/...`, call the API handler.
          return handleApiRequest(path.slice(1), request, env);
        case 'public':
          return handlePublicRequest(path.slice(1), request, env, ctx);
        default:
          return new Response("Not found", {status: 404});
      }
    });
  }
}

async function handlePublicRequest(path, request, env, ctx) {
  try {
    const event = {
      request,
      waitUntil(promise) {
        return ctx.waitUntil(promise)
      },
    }
    const options = {};
    function handlePrefix(prefix) {
      return request => {
        // compute the default (e.g. / -> index.html)
        let defaultAssetKey = mapRequestToAsset(request)
        let url = new URL(defaultAssetKey.url)
    
        // strip the prefix from the path for lookup
        url.pathname = url.pathname.replace(prefix, '/')
    
        // inherit all other props from the default request
        return new Request(url.toString(), defaultAssetKey)
      }
    }
    options.mapRequestToAsset = handlePrefix(/^\/public/);
    options.ASSET_NAMESPACE = env.__STATIC_CONTENT;
    options.ASSET_MANIFEST = assetManifest;
    const page = await getAssetFromKV(event, options)

    // allow headers to be altered
    const response = new Response(page.body, page);

    console.log('got response', response);

    return response;
  } catch(err) {
    console.log('error', err);
    return new Response(err.stack, {
      status: 500,
    })
  }
}

async function handleApiRequest(path, request, env) {
  // We've received at API request. Route the request based on the path.

  switch (path[0]) {
    case "room": {
      // Request for `/api/room/...`.

      if (!path[1]) {
        // The request is for just "/api/room", with no ID.
        if (request.method == "POST") {
          // POST to /api/room creates a private room.
          //
          // Incidentally, this code doesn't actually store anything. It just generates a valid
          // unique ID for this namespace. Each durable object namespace has its own ID space, but
          // IDs from one namespace are not valid for any other.
          //
          // The IDs returned by `newUniqueId()` are unguessable, so are a valid way to implement
          // "anyone with the link can access" sharing. Additionally, IDs generated this way have
          // a performance benefit over IDs generated from names: When a unique ID is generated,
          // the system knows it is unique without having to communicate with the rest of the
          // world -- i.e., there is no way that someone in the UK and someone in New Zealand
          // could coincidentally create the same ID at the same time, because unique IDs are,
          // well, unique!
          let id = env.rooms.newUniqueId();
          return new Response(id.toString(), {headers: {"Access-Control-Allow-Origin": "*"}});
        } else {
          // If we wanted to support returning a list of public rooms, this might be a place to do
          // it. The list of room names might be a good thing to store in KV, though a singleton
          // Durable Object is also a possibility as long as the Cache API is used to cache reads.
          // (A caching layer would be needed because a single Durable Object is single-threaded,
          // so the amount of traffic it can handle is limited. Also, caching would improve latency
          // for users who don't happen to be located close to the singleton.)
          //
          // For this demo, though, we're not implementing a public room list, mainly because
          // inevitably some trolls would probably register a bunch of offensive room names. Sigh.
          return new Response("Method not allowed", {status: 405});
        }
      }

      // OK, the request is for `/api/room/<name>/...`. It's time to route to the Durable Object
      // for the specific room.
      let name = path[1];

      // Each Durable Object has a 256-bit unique ID. IDs can be derived from string names, or
      // chosen randomly by the system.
      let id;
      if (name.match(/^[0-9a-f]{64}$/)) {
        // The name is 64 hex digits, so let's assume it actually just encodes an ID. We use this
        // for private rooms. `idFromString()` simply parses the text as a hex encoding of the raw
        // ID (and verifies that this is a valid ID for this namespace).
        id = env.rooms.idFromString(name);
      } else if (name.length <= 32) {
        // Treat as a string room name (limited to 32 characters). `idFromName()` consistently
        // derives an ID from a string.
        id = env.rooms.idFromName(name);
      } else {
        return new Response("Name too long", {status: 404});
      }

      // Get the Durable Object stub for this room! The stub is a client object that can be used
      // to send messages to the remote Durable Object instance. The stub is returned immediately;
      // there is no need to await it. This is important because you would not want to wait for
      // a network round trip before you could start sending requests. Since Durable Objects are
      // created on-demand when the ID is first used, there's nothing to wait for anyway; we know
      // an object will be available somewhere to receive our requests.
      let roomObject = env.rooms.get(id);

      // Compute a new URL with `/api/room/<name>` removed. We'll forward the rest of the path
      // to the Durable Object.
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");

      // Send the request to the object. The `fetch()` method of a Durable Object stub has the
      // same signature as the global `fetch()` function, but the request is always sent to the
      // object, regardless of the request's URL.
      return roomObject.fetch(newUrl, request);
    }

    default:
      return new Response("Not found", {status: 404});
  }
}

//

function makeid(length) {
  var result           = '';
  var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var charactersLength = characters.length;
  for ( var i = 0; i < length; i++ ) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
 }
 return result;
}
const makeId = () => makeid(5);

//

class DCMap extends EventTarget {
  constructor(arrayId, arrayIndexId, dataClient) {
    super();

    this.arrayId = arrayId;
    this.arrayIndexId = arrayIndexId;
    this.dataClient = dataClient;

    this.cleanupFn = null;
  }
  getObject() {
    return this.dataClient.crdt.get(this.arrayIndexId);
  }
  getKey(key) {
    const object = this.getObject();
    if (object) {
      const valSpec = object[key];
      if (valSpec !== undefined) {
        const [epoch, val] = valSpec;
        return val;
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
  }
  getEpoch(key) {
    const object = this.getObject();
    if (object) {
      const valSpec = object[key];
      if (valSpec !== undefined) {
        const [epoch, val] = valSpec;
        return epoch;
      } else {
        return 0;
      }
    } else {
      return 0;
    }
  }

  // client
  setKeyValue(key, value) {
    let object = this.getObject();
    if (!object) {
      object = {};
      this.dataClient.crdt.set(this.arrayIndexId, object);
    }
    const oldEpoch = object[key] ? object[key][0] : 0;
    object[key] = [oldEpoch + 1, value];
  }
  setKeyEpochValue(key, epoch, val) {
    let object = this.getObject();
    if (!object) {
      object = {};
      this.dataClient.crdt.set(this.arrayIndexId, object);
    }
    if (object[key]) {
      object[key][0] = epoch;
      object[key][1] = val;
    } else {
      object[key] = [epoch, val];
    }
  }

  setKeyEpochValueUpdate(key, epoch, val) {
    this.setKeyEpochValue(key, epoch, val);

    return new MessageEvent('set.' + this.arrayId + '.' + this.arrayIndexId, {
      data: {
        key,
        epoch,
        val,
      }
    });
  }
  removeUpdate() {
    this.dataClient.crdt.delete(this.arrayIndexId);
    
    return new MessageEvent('remove.' + this.arrayId, {
      data: {
        arrayIndexId: this.arrayIndexId,
      },
    });
  }

  // server
  trySetKeyEpochValue(key, epoch, val) {
    let object = this.getObject();
    if (!object) {
      object = {};
      this.dataClient.crdt.set(this.arrayIndexId, object);
    }

    const oldEpoch = object[key] ? object[key][0] : 0;
    if (epoch > oldEpoch) {
      if (object[key]) {
        object[key][0] = epoch;
        object[key][1] = val;
      } else {
        object[key] = [epoch, val];
      }
      return undefined;
    } else {
      return object[key];
    }
  }
  listen() {
    const setKey = 'set.' + this.arrayId + '.' + this.arrayIndexId;
    const setFn = e => {
      const {key, epoch, val} = e.data;
      this.dispatchEvent(new MessageEvent('set', {
        data: {
          key,
          epoch,
          val,
        },
      }));
    };
    this.dataClient.addEventListener(setKey, setFn);
    this.cleanupFn = () => {
      this.dataClient.removeEventListener(setKey, setFn);
    };
  }
  destroy() {
    if (this.cleanupFn) {
      this.cleanupFn();
      this.cleanupFn = null;
    }
  }
}
class DCArray extends EventTarget {
  constructor(arrayId, dataClient) {
    super();
    this.arrayId = arrayId;
    this.dataClient = dataClient;

    this.cleanupFn = null;
  }
  add(val) {
    return this.dataClient.createArrayMapElement(this.arrayId, val);
  }
  listen() {
    const addKey = 'add.' + this.arrayId;
    const addFn = e => {
      const {
        arrayIndexId,
      } = e.data;
      const map = new DCMap(arrayId, arrayIndexId, this.dataClient);
      map.listen();
      this.dispatchEvent(new MessageEvent('add', {
        data: {
          map,
        },
      }));
    };
    this.dataClient.addEventListener(addKey, addFn);

    const removeKey = 'remove.' + this.arrayId;
    const removeFn = e => {
      const {
        arrayIndexId,
      } = e.data;
      this.dispatchEvent(new MessageEvent('remove', {
        data: {
          arrayIndexId,
        },
      }));
    };
    this.dataClient.addEventListener(removeKey, removeFn);

    this.cleanupFn = () => {
      this.dataClient.removeEventListener(addKey, addFn);
      this.dataClient.removeEventListener(removeKey, removeFn);
    };
  }
  destroy() {
    if (this.cleanupFn) {
      this.cleanupFn();
      this.cleanupFn = null;
    }
  }
}
class DataClient extends EventTarget {
  constructor({
    crdt = null,
  } = {}) {
    super();

    // this.storage = storage;
    // this.websocket = websocket;

    this.crdt = crdt;
  }
  static UPDATE_METHODS = {
    SET: 1,
    ADD: 2,
    REMOVE: 3,
    ROLLBACK: 4,
  };

  // for both client and server
  applyUint8Array(uint8Array, {
    force = false, // force if it's coming from the server
  } = {}) {
    let rollback = null;
    let update = null;

    const {method, args} = zbdecode(uint8Array);
    switch (method) {
      case DataClient.UPDATE_METHODS.SET: {
        const [arrayName, arrayIndexId, key, epoch, val] = args;
        const arrayMap = new DCMap(arrayName, arrayIndexId, this);
        let oldObject;
        if (force) {
          arrayMap.setKeyEpochValue(key, epoch, val);
        } else {
          oldObject = arrayMap.trySetKeyEpochValue(key, epoch, val);
        }
        if (oldObject === undefined) {
          // accept update
          update = new MessageEvent('set.' + arrayName + '.' + arrayIndexId, {
            data: {
              key,
              epoch,
              val,
            },
          });
        } else {
          const [oldEpoch, oldVal] = oldObject;
          // reject update and roll back
          rollback = zbencode({
            method: DataClient.UPDATE_METHODS.ROLLBACK,
            args: [arrayIndexId, key, oldEpoch, oldVal],
          });
        }
        break;
      }
      case DataClient.UPDATE_METHODS.ADD: {
        const [arrayId, arrayIndexId, val] = args;
        this.crdt.set(arrayIndexId, val);
        
        let array = this.crdt.get(arrayId);
        if (!array) {
          array = new Set();
          this.crdt.set(arrayId, array);
        }
        array.add(arrayIndexId);

        update = new MessageEvent('add.' + arrayId, {
          data: {
            // arrayId,
            arrayIndexId,
            // val,
          },
        });
        break;
      }
      case DataClient.UPDATE_METHODS.REMOVE: {
        const [arrayId, arrayIndexId] = args;
        let array = this.crdt.get(arrayId);
        if (!array) {
          array = new Set();
          this.crdt.set(arrayId, array);
        }
        array.delete(arrayIndexId);

        update = new MessageEvent('remove.' + arrayId, {
          data: {
            // arrayId,
            arrayIndexId,
          },
        });
        break;
      }
      case DataClient.UPDATE_METHODS.ROLLBACK: {
        const [arrayIndexId, key, epoch, val] = args;
        const object = this.crdt.get(arrayIndexId);
        if (object) {
          if (object[key]) {
            object[key][0] = epoch;
            object[key][1] = val;
          } else {
            object[key] = [epoch, val];
          }

          update = new MessageEvent('set.' + arrayIndexId, {
            data: {
              key,
              epoch,
              val,
            },
          });
        } else {
          throw new Error('got rollback for nonexistent object');
        }

        break;
      }
    }
    // this.storage = zbdecode(new Uint8Array(arrayBuffer));
    // const rollbackUint8Array = new Uint8Array(0);
    return {
      rollback,
      update,
    };
  }

  // for server
  triggerSave(m, saveKeyFn) {
    const match = m.type.match(/^set\.(.+?)\.(.+?)$/);
    if (match) {
      const arrayName = match[1];
      const arrayIndexId = match[2];
      saveKeyFn(arrayIndexId);
    } else {
      const match = m.type.match(/^add\.(.+?)$/);
      if (match) {
        const arrayName = match[1];
        const {arrayIndexId} = m.data;
        saveKeyFn(arrayIndexId);
        saveKeyFn(arrayName);
      } else {
        const match = m.type.match(/^remove\.(.+?)$/);
        if (match) {
          const arrayName = match[1];
          const {arrayIndexId} = m.data;
          saveKeyFn(arrayIndexId);
          saveKeyFn(arrayName);
        } else {
          throw new Error('unrecognized message type: ' + m.type);
        }
      }
    }
  }
  
  // for client
  createArrayMapElement(arrayId, val = {}) {
    const arrayIndexId = makeId();
    return this.addArrayMapElement(arrayId, arrayIndexId, val);
  }
  addArrayMapElement(arrayId, arrayIndexId, val = {}) {
    this.crdt.set(arrayIndexId, val);
    
    let array = this.crdt.get(arrayId);
    if (!array) {
      array = new Set();
      this.crdt.set(arrayId, array);
    }
    array.add(arrayIndexId);

    const map = new DCMap(arrayId, arrayIndexId, this);

    this.dispatchEvent(new MessageEvent('add.' + arrayId, {
      data: {
        // arrayId,
        arrayIndexId,
        // val,
      },
    }));
    return map;
  }
  removeArrayMapElement(arrayId, arrayIndexId) {
    let array = this.crdt.get(arrayId);
    if (!array) {
      array = new Set();
      this.crdt.set(arrayId, array);
    }
    if (array.has(arrayId)) {
      if (this.crdt.has(arrayIndexId)) {
        this.crdt.delete(arrayIndexId);
        array.delete(arrayIndexId);

        this.dispatchEvent(new MessageEvent('remove.' + arrayId, {
          data: {
            // arrayId,
            arrayIndexId,
          },
        }));
      } else {
        throw new Error('array index id not found');
      }
    } else {
      throw new Error('array index not found');
    }
  }
  readBinding(arrayNames) {
    let arrays = {};
    let arrayMaps = {};
    if (this.crdt) {
      arrayNames.forEach(arrayId => {
        const array = this.crdt.get(arrayId);
        const localArrayMaps = [];
        if (array) {
          for (const arrayIndexId of array) {
            const arrayMap = new DCMap(arrayId, arrayIndexId, this);
            arrayMap.listen();
            localArrayMaps.push(arrayMap);
          }
        }

        arrays[arrayId] = new DCArray(arrayId, this);
        arrays[arrayId].listen();
        arrayMaps[arrayId] = localArrayMaps;
      });
      return {
        arrays,
        arrayMaps,
      };
    } else {
      throw new Error('crdt was not initialized; it has not gotten its first message');
    }
  }
}
const readCrdtFromStorage = async (storage, arrayNames) => {
  const crdt = new Map();
  for (const arrayId of arrayNames) {
    const array = await storage.get(arrayId) ?? new Set();
    crdt.set(arrayId, array);

    for (const arrayIndexId of array) {
      const val = await storage.get(arrayIndexId) ?? {};
      crdt.set(arrayIndexId, val);
    }
  }
  return crdt;
};
let dataClientPromise = null;

//

const MESSAGE_TYPES = {
  AUDIO: 1,
  DATA: 2,
};
const schemaArrayNames = [
  'players',
  'objects',
];

// =======================================================================================
// The ChatRoom Durable Object Class

// ChatRoom implements a Durable Object that coordinates an individual chat room. Participants
// connect to the room using WebSockets, and the room broadcasts messages from each participant
// to all others.
export class ChatRoom {
  constructor(controller, env) {
    // `controller.storage` provides access to our durable storage. It provides a simple KV
    // get()/put() interface.
    this.storage = controller.storage;

    // `env` is our environment bindings (discussed earlier).
    this.env = env;

    // We will put the WebSocket objects for each client, along with some metadata, into
    // `sessions`.
    this.sessions = [];

    // We keep track of the last-seen message's timestamp just so that we can assign monotonically
    // increasing timestamps even if multiple messages arrive simultaneously (see below). There's
    // no need to store this to disk since we assume if the object is destroyed and recreated, much
    // more than a millisecond will have gone by.
    this.lastTimestamp = 0;
  }

  // The system will call fetch() whenever an HTTP request is sent to this Object. Such requests
  // can only be sent from other Worker code, such as the code above; these requests don't come
  // directly from the internet. In the future, we will support other formats than HTTP for these
  // communications, but we started with HTTP for its familiarity.
  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/websocket": {
          // The request is to `/api/room/<name>/websocket`. A client is trying to establish a new
          // WebSocket session.
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", {status: 400});
          }

          // Get the client's IP address for use with the rate limiter.
          let ip = request.headers.get("CF-Connecting-IP");

          // To accept the WebSocket request, we create a WebSocketPair (which is like a socketpair,
          // i.e. two WebSockets that talk to each other), we return one end of the pair in the
          // response, and we operate on the other end. Note that this API is not part of the
          // Fetch API standard; unfortunately, the Fetch API / Service Workers specs do not define
          // any way to act as a WebSocket server today.
          let pair = new WebSocketPair();

          // We're going to take pair[1] as our end, and return pair[0] to the client.
          await this.handleSession(pair[1], ip);

          // Now we return the other end of the pair to the client.
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }

  // handleSession() implements our WebSocket-based chat protocol.
  async handleSession(webSocket, ip) {
    // Accept our end of the WebSocket. This tells the runtime that we'll be terminating the
    // WebSocket in JavaScript, not sending it elsewhere.
    webSocket.accept();

    const _resumeWebsocket = _pauseWebSocket(webSocket);

    if (!dataClientPromise) {
      dataClientPromise = (async () => {
        const crdt = await readCrdtFromStorage(this.storage, schemaArrayNames);
        return new DataClient({
          crdt,
        });
      })();
    }
    const dataClient = await dataClientPromise;

    // Set up our rate limiter client.
    // let limiterId = this.env.limiters.idFromName(ip);
    // let limiter = new RateLimiterClient(
    //     () => this.env.limiters.get(limiterId),
    //     err => webSocket.close(1011, err.stack));

    // Create our session and add it to the sessions list.
    // We don't send any messages to the client until it has sent us the initial user info
    // message. Until then, we will queue messages in `session.blockedMessages`.
    let session = {webSocket, blockedMessages: []};
    this.sessions.push(session);

    // Queue "join" messages for all online users, to populate the client's roster.
    this.sessions.forEach(otherSession => {
      if (otherSession.name) {
        session.blockedMessages.push(JSON.stringify({joined: otherSession.name}));
      }
    });

    // respond back to the client
    const respondToSelf = messages => {
      for (const message of messages) {
        session.webSocket.send(message);
      }
    };

    // send a message to everyone on the list except us
    const proxyMessageToPeers = m => {
      for (const s of this.sessions) {
        if (s !== session) {
          s.webSocket.send(m);
        }
      }
    };

    // Load the last 100 messages from the chat history stored on disk, and send them to the
    // client.
    // let storage = await this.storage.list({reverse: true, limit: 100});
    /* let backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach(value => {
      session.blockedMessages.push(value);
    }); */

    const handleBinaryMessage = (arrayBuffer) => {
      let result = null;
    
      const dataView = new DataView(arrayBuffer);
      // const byteLength = dataView.getUint32(Uint32Array.BYTES_PER_ELEMENT, true);
      const messageType = dataView.getUint32(Uint32Array.BYTES_PER_ELEMENT, true);
      switch (messageType) {
        case MESSAGE_TYPES.AUDIO: {
          // proxy
          break;
        }
        case MESSAGE_TYPES.DATA: {
          const uint8Array = new Uint8Array(arrayBuffer, Uint32Array.BYTES_PER_ELEMENT);
          const {rollback, update} = dataClient.applyUint8Array(uint8Array);
          if (rollback) {
            result = [rollback];
          }
          if (update) {
            dataClient.triggerSave(update, key => {
              this.storage.put(key, this.crdt.get(key));
            });
          }
          break;
        }
      }
      if (result) {
        respondToSelf(result);
      } else {
        // console.log('got arraybuffer', arrayBuffer);
        proxyMessageToPeers(arrayBuffer);
      }
    };

    // Set event handlers to receive messages.
    // let receivedUserInfo = false;
    webSocket.addEventListener("message", async msg => {
      try {
        if (session.quit) {
          // Whoops, when trying to send to this WebSocket in the past, it threw an exception and
          // we marked it broken. But somehow we got another message? I guess try sending a
          // close(), which might throw, in which case we'll try to send an error, which will also
          // throw, and whatever, at least we won't accept the message. (This probably can't
          // actually happen. This is defensive coding.)
          webSocket.close(1011, "WebSocket broken.");
          return;
        }

        // Check if the user is over their rate limit and reject the message if so.
        /* if (!limiter.checkLimit()) {
          webSocket.send(JSON.stringify({
            error: "Your IP is being rate-limited, please try again later."
          }));
          return;
        } */

        if (msg.data instanceof ArrayBuffer) {
          const arrayBuffer = msg.data;
          handleBinaryMessage(arrayBuffer);
        } else {
          // I guess we'll use JSON.
          const data = JSON.parse(msg.data);
          const {method} = data;
          if (method) {
            switch (method) {
              case 'ping': {
                // console.log('ping');
                break;
              }
              case 'chat': {
                const {playerId, message} = data.args;
                // console.log('replicate', playerId, message);
                const m = JSON.stringify({
                  method: 'chat',
                  args: {
                    playerId,
                    message,
                  },
                });
                proxyMessageToPeers(m);
              }
            }
          } else {
            console.warn('could not handle message', data);
          }
        }

        /* if (!receivedUserInfo) {
          // The first message the client sends is the user info message with their name. Save it
          // into their session object.
          session.name = "" + (data.name || "anonymous");

          // Don't let people use ridiculously long names. (This is also enforced on the client,
          // so if they get here they are not using the intended client.)
          if (session.name.length > 32) {
            webSocket.send(JSON.stringify({error: "Name too long."}));
            webSocket.close(1009, "Name too long.");
            return;
          }

          // Deliver all the messages we queued up since the user connected.
          session.blockedMessages.forEach(queued => {
            webSocket.send(queued);
          });
          delete session.blockedMessages;

          // Broadcast to all other connections that this user has joined.
          this.broadcast({joined: session.name});

          webSocket.send(JSON.stringify({ready: true}));

          // Note that we've now received the user info message.
          receivedUserInfo = true;

          return;
        }

        // Construct sanitized message for storage and broadcast.
        data = { name: session.name, message: "" + data.message };

        // Block people from sending overly long messages. This is also enforced on the client,
        // so to trigger this the user must be bypassing the client code.
        if (data.message.length > 256) {
          webSocket.send(JSON.stringify({error: "Message too long."}));
          return;
        }

        // Add timestamp. Here's where this.lastTimestamp comes in -- if we receive a bunch of
        // messages at the same time (or if the clock somehow goes backwards????), we'll assign
        // them sequential timestamps, so at least the ordering is maintained.
        data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
        this.lastTimestamp = data.timestamp;

        // Broadcast the message to all other WebSockets.
        let dataStr = JSON.stringify(data);
        this.broadcast(dataStr);

        // Save message.
        let key = new Date(data.timestamp).toISOString();
        await this.storage.put(key, dataStr); (*/
      } catch (err) {
        // Report any exceptions directly back to the client. As with our handleErrors() this
        // probably isn't what you'd want to do in production, but it's convenient when testing.
        console.warn(err);
        webSocket.send(JSON.stringify({error: err.stack}));
      }
    });

    // On "close" and "error" events, remove the WebSocket from the sessions list and broadcast
    // a quit message.
    let closeOrErrorHandler = evt => {
      session.quit = true;
      this.sessions = this.sessions.filter(member => member !== session);
      if (session.name) {
        this.broadcast({quit: session.name});
      }
    };
    webSocket.addEventListener("close", closeOrErrorHandler);
    webSocket.addEventListener("error", closeOrErrorHandler);

    _resumeWebsocket();
  }

  // broadcast() broadcasts a message to all clients.
  broadcast(message) {
    // Apply JSON if we weren't given a string to start with.
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }

    // Iterate over all the sessions sending them messages.
    let quitters = [];
    this.sessions = this.sessions.filter(session => {
      if (session.name) {
        try {
          session.webSocket.send(message);
          return true;
        } catch (err) {
          // Whoops, this connection is dead. Remove it from the list and arrange to notify
          // everyone below.
          session.quit = true;
          quitters.push(session);
          return false;
        }
      } else {
        // This session hasn't sent the initial user info message yet, so we're not sending them
        // messages yet (no secret lurking!). Queue the message to be sent later.
        session.blockedMessages.push(message);
        return true;
      }
    });

    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({quit: quitter.name});
      }
    });
  }
}

// =======================================================================================
// The RateLimiter Durable Object class.

// RateLimiter implements a Durable Object that tracks the frequency of messages from a particular
// source and decides when messages should be dropped because the source is sending too many
// messages.
//
// We utilize this in ChatRoom, above, to apply a per-IP-address rate limit. These limits are
// global, i.e. they apply across all chat rooms, so if a user spams one chat room, they will find
// themselves rate limited in all other chat rooms simultaneously.
export class RateLimiter {
  constructor(controller, env) {
    // Timestamp at which this IP will next be allowed to send a message. Start in the distant
    // past, i.e. the IP can send a message now.
    this.nextAllowedTime = 0;
  }

  // Our protocol is: POST when the IP performs an action, or GET to simply read the current limit.
  // Either way, the result is the number of seconds to wait before allowing the IP to perform its
  // next action.
  async fetch(request) {
    return await handleErrors(request, async () => {
      let now = Date.now() / 1000;

      this.nextAllowedTime = Math.max(now, this.nextAllowedTime);

      if (request.method == "POST") {
        // POST request means the user performed an action.
        // We allow one action per 5 seconds.
        this.nextAllowedTime += 5;
      }

      // Return the number of seconds that the client needs to wait.
      //
      // We provide a "grace" period of 20 seconds, meaning that the client can make 4-5 requests
      // in a quick burst before they start being limited.
      let cooldown = Math.max(0, this.nextAllowedTime - now - 20);
      return new Response(cooldown);
    })
  }
}

// RateLimiterClient implements rate limiting logic on the caller's side.
class RateLimiterClient {
  // The constructor takes two functions:
  // * getLimiterStub() returns a new Durable Object stub for the RateLimiter object that manages
  //   the limit. This may be called multiple times as needed to reconnect, if the connection is
  //   lost.
  // * reportError(err) is called when something goes wrong and the rate limiter is broken. It
  //   should probably disconnect the client, so that they can reconnect and start over.
  constructor(getLimiterStub, reportError) {
    this.getLimiterStub = getLimiterStub;
    this.reportError = reportError;

    // Call the callback to get the initial stub.
    this.limiter = getLimiterStub();

    // When `inCooldown` is true, the rate limit is currently applied and checkLimit() will return
    // false.
    this.inCooldown = false;
  }

  // Call checkLimit() when a message is received to decide if it should be blocked due to the
  // rate limit. Returns `true` if the message should be accepted, `false` to reject.
  checkLimit() {
    if (this.inCooldown) {
      return false;
    }
    this.inCooldown = true;
    this.callLimiter();
    return true;
  }

  // callLimiter() is an internal method which talks to the rate limiter.
  async callLimiter() {
    try {
      let response;
      try {
        // Currently, fetch() needs a valid URL even though it's not actually going to the
        // internet. We may loosen this in the future to accept an arbitrary string. But for now,
        // we have to provide a dummy URL that will be ignored at the other end anyway.
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      } catch (err) {
        // `fetch()` threw an exception. This is probably because the limiter has been
        // disconnected. Stubs implement E-order semantics, meaning that calls to the same stub
        // are delivered to the remote object in order, until the stub becomes disconnected, after
        // which point all further calls fail. This guarantee makes a lot of complex interaction
        // patterns easier, but it means we must be prepared for the occasional disconnect, as
        // networks are inherently unreliable.
        //
        // Anyway, get a new limiter and try again. If it fails again, something else is probably
        // wrong.
        this.limiter = this.getLimiterStub();
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      }

      // The response indicates how long we want to pause before accepting more requests.
      let cooldown = +(await response.text());
      await new Promise(resolve => setTimeout(resolve, cooldown * 1000));

      // Done waiting.
      this.inCooldown = false;
    } catch (err) {
      this.reportError(err);
    }
  }
}
