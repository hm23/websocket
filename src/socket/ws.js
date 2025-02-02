"use strict";

const URL = require("url");
const cds = require("@sap/cds");
const WebSocket = require("ws");

const SocketServer = require("./base");

const LOG = cds.log("/websocket/ws");
const DEBUG = cds.debug("websocket");

class SocketWSServer extends SocketServer {
  constructor(server, path, config) {
    super(server, path, config);
    this.wss = new WebSocket.Server({ server });
    this.services = {};
    cds.ws = this;
    cds.wss = this.wss;
  }

  async setup() {
    await this.applyAdapter();
    this._middlewares = this.middlewares();
    this.wss.on("connection", async (ws, request) => {
      const url = request?.url;
      if (url) {
        const urlObj = URL.parse(url, true);
        request.queryOptions = urlObj.query;
        request.url = urlObj.pathname;
        this.services[request.url]?.(ws, request);
      }
    });
  }

  service(service, connected) {
    this.adapter?.on(service);
    const servicePath = `${this.path}${service}`;
    this.services[servicePath] = (ws, request) => {
      ws.request = request;
      ws.events = {};
      ws.contexts = {};
      DEBUG?.("Connected");
      ws.on("close", () => {
        ws.contexts = {};
        DEBUG?.("Disconnected");
      });
      ws.on("error", (error) => {
        LOG?.error(error);
      });
      ws.on("message", async (message) => {
        let payload = {};
        try {
          payload = JSON.parse(message);
        } catch {
          // ignore
        }
        try {
          for (const callback of ws.events[payload?.event] || []) {
            await callback(payload.data);
          }
        } catch (err) {
          LOG?.error(err);
        }
      });
      this.applyMiddlewares(ws, async () => {
        try {
          this.enforceAuth(ws);
          ws.tenant = ws.request.tenant;
          ws.user = ws.request.user?.id;
          const facade = {
            service,
            socket: ws,
            get context() {
              return {
                id: ws.request.correlationId,
                user: ws.request.user,
                tenant: ws.request.tenant,
                http: { req: ws.request, res: ws.request.res },
                ws: { service: facade, socket: ws },
              };
            },
            on: (event, callback) => {
              ws.events[event] ??= [];
              ws.events[event].push(callback);
            },
            emit: async (event, data) => {
              await ws.send(
                JSON.stringify({
                  event,
                  data,
                }),
              );
            },
            broadcast: async (event, data, user, contexts, identifier) => {
              await this.broadcast({
                service,
                event,
                data,
                tenant: ws.tenant,
                user,
                contexts,
                identifier,
                socket: ws,
                remote: true,
              });
            },
            broadcastAll: async (event, data, user, contexts, identifier) => {
              await this.broadcast({
                service,
                event,
                data,
                tenant: ws.tenant,
                user,
                contexts,
                identifier,
                socket: null,
                remote: true,
              });
            },
            enter: async (context) => {
              ws.contexts[context] = true;
            },
            exit: async (context) => {
              delete ws.contexts[context];
            },
            disconnect() {
              ws.close();
            },
            onDisconnect: (callback) => {
              ws.on("close", callback);
            },
          };
          ws.facade = facade;
          connected && connected(facade);
        } catch (err) {
          LOG?.error(err);
        }
      });
    };
  }

  async broadcast({ service, event, data, tenant, user, contexts, identifier, socket, remote }) {
    const eventMessage = event;
    const isEventMessage = !data;
    if (isEventMessage) {
      const message = JSON.parse(eventMessage);
      event = message.event;
      data = message.data;
      tenant = message.tenant;
      user = message.user;
      contexts = message.contexts;
      identifier = message.identifier;
    }
    const servicePath = `${this.path}${service}`;
    const clients = [];
    this.wss.clients.forEach((client) => {
      if (
        client !== socket &&
        client.readyState === WebSocket.OPEN &&
        client.request?.url === servicePath &&
        client.tenant === tenant &&
        (!user || client.user !== user) &&
        (!contexts ||
          contexts.find((context) => {
            return !!client.contexts[context];
          })) &&
        (!identifier || client.request?.queryOptions?.id !== identifier)
      ) {
        clients.push(client);
      }
    });
    if (clients.length > 0) {
      const clientMessage = JSON.stringify({
        event,
        data,
      });
      for (const client of clients) {
        await client.send(clientMessage);
      }
    }
    if (remote) {
      const adapterMessage = isEventMessage
        ? eventMessage
        : JSON.stringify({ event, data, tenant, user, contexts, identifier });
      await this.adapter?.emit(service, adapterMessage);
    }
  }

  close(socket, code, reason) {
    if (socket) {
      socket.close(code, reason);
    } else {
      this.wss.close();
    }
  }

  async applyAdapter() {
    try {
      const config = { ...this.config?.adapter };
      if (config.impl) {
        const adapterFactory = SocketServer.require(config.impl, "adapter");
        this.adapter = new adapterFactory(this, config);
        await this.adapter?.setup?.();
        this.adapterActive = !!this.adapter?.client;
      }
    } catch (err) {
      LOG?.error(err);
    }
  }

  applyMiddlewares(ws, next) {
    const middlewares = this._middlewares.slice(0);

    function call() {
      try {
        const middleware = middlewares.shift();
        if (!middleware) {
          return next(null);
        }
        middleware(ws, (err) => {
          if (err) {
            next(err);
          } else {
            call();
          }
        });
      } catch (err) {
        next(err);
      }
    }

    call();
  }
}

module.exports = SocketWSServer;
