'use strict';

// Generic factory replacing 4 structurally-identical SSE hubs that used to be hand-duplicated
// in server.js (channel messages, direct messages, task comments, brief-progress): each is a
// Map<key, Set<response>> with add (create-if-absent), remove (delete, cleanup empty set),
// broadcast (`data: ${JSON.stringify(payload)}\n\n`), and a 25s keep-alive ping loop.
function createSseHub() {
  const clients = new Map();

  function add(key, response) {
    if (!clients.has(key)) clients.set(key, new Set());
    clients.get(key).add(response);
  }

  function remove(key, response) {
    const set = clients.get(key);
    if (!set) return;
    set.delete(response);
    if (!set.size) clients.delete(key);
  }

  function broadcast(key, payload) {
    const set = clients.get(key);
    if (!set || !set.size) return;
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const response of set) {
      if (!response.writableEnded) response.write(frame);
    }
  }

  setInterval(() => {
    for (const set of clients.values()) {
      for (const response of set) {
        if (!response.writableEnded) response.write(': ping\n\n');
      }
    }
  }, 25_000).unref();

  return { add, remove, broadcast };
}

module.exports = { createSseHub };
