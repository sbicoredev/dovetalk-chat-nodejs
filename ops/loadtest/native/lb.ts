import net from "node:net";

/**
 * A least-connections TCP load balancer for running the scale-out test WITHOUT Docker. It stands in
 * for nginx (ops/docker/nginx.conf), which is what the Compose `scale` profile really uses.
 *
 *   node native/lb.ts --listen 8080 --upstreams 127.0.0.1:3101,127.0.0.1:3102,127.0.0.1:3103
 *
 * It forwards bytes and knows nothing of HTTP, so it serves REST and WebSocket alike and needs no
 * sticky sessions, which is the point. An upstream that refuses a connection is skipped for 5 s,
 * like nginx's passive `max_fails`/`fail_timeout`, and the connection is tried on the next one.
 */

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? (argv[at + 1] as string) : fallback;
};

const listenPort = Number(flag("listen", "8080"));
const upstreams = flag("upstreams", "127.0.0.1:3101")
  .split(",")
  .map((entry) => {
    const [host, port] = entry.split(":");
    return { host: host as string, port: Number(port), active: 0, downUntil: 0 };
  });

function pick(excluded: Set<number>) {
  const now = Date.now();
  let best = -1;
  for (const [index, upstream] of upstreams.entries()) {
    if (excluded.has(index) || upstream.downUntil > now) {
      continue;
    }
    if (best === -1 || upstream.active < (upstreams[best] as (typeof upstreams)[number]).active) {
      best = index;
    }
  }
  return best;
}

const server = net.createServer({ pauseOnConnect: true }, (client) => {
  client.setNoDelay(true);
  const tried = new Set<number>();

  const attempt = () => {
    const index = pick(tried);
    if (index === -1) {
      client.destroy();
      return;
    }
    tried.add(index);
    const upstream = upstreams[index] as (typeof upstreams)[number];
    const back = net.connect(upstream.port, upstream.host);
    back.setNoDelay(true);
    let connected = false;
    back.once("connect", () => {
      connected = true;
      upstream.active += 1;
      client.pipe(back);
      back.pipe(client);
      client.resume();
    });
    back.on("error", () => {
      if (connected) {
        client.destroy();
      } else {
        upstream.downUntil = Date.now() + 5000;
        attempt();
      }
    });
    back.on("close", () => {
      if (connected) {
        upstream.active -= 1;
      }
      client.destroy();
    });
    client.on("close", () => back.destroy());
  };
  client.on("error", () => undefined);
  attempt();
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(
    `lb listening on 127.0.0.1:${listenPort} -> ${upstreams.map((u) => `${u.host}:${u.port}`).join(", ")}`,
  );
});
