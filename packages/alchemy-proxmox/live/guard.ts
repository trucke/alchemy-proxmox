import { createServer, request } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

export function required(key: string) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
export const settings = () => {
  const min = Number(required("PROXMOX_TEST_MIN_VMID"));
  const max = Number(required("PROXMOX_TEST_MAX_VMID"));
  assert(
    Number.isSafeInteger(min) && Number.isSafeInteger(max) && min > 0 && max > min,
    "Invalid allowed VMID range",
  );
  return {
    min,
    max,
    node: required("PROXMOX_TEST_NODE"),
    pool: required("PROXMOX_TEST_POOL"),
    storage: required("PROXMOX_TEST_STORAGE"),
  };
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Every file the download phase writes or deletes carries this prefix. */
export const DOWNLOAD_PREFIX = "alchemy-test-";
const testFile = (name: string | null | undefined) =>
  typeof name === "string" && name.startsWith(DOWNLOAD_PREFIX) && /^[A-Za-z0-9_.-]+$/.test(name);
/** The opt-in download phase runs only when all of its variables are set. */
export const downloadSettings = () => {
  const keys = [
    "PROXMOX_TEST_DOWNLOAD_STORAGE",
    "PROXMOX_TEST_DOWNLOAD_URL",
    "PROXMOX_TEST_DOWNLOAD_SHA512",
  ];
  const set = keys.filter((key) => process.env[key]);
  if (set.length === 0) return undefined;
  assert.equal(set.length, keys.length, `Set all of ${keys.join(", ")} or none`);
  const url = new URL(required("PROXMOX_TEST_DOWNLOAD_URL"));
  assert(["http:", "https:"].includes(url.protocol), "Download URL must use HTTP or HTTPS");
  const sha512 = required("PROXMOX_TEST_DOWNLOAD_SHA512");
  assert(/^[0-9a-f]{128}$/i.test(sha512), "PROXMOX_TEST_DOWNLOAD_SHA512 must be a SHA-512 digest");
  const storage = required("PROXMOX_TEST_DOWNLOAD_STORAGE");
  const filename = `${DOWNLOAD_PREFIX}${url.pathname.split("/").pop()}`;
  assert(testFile(filename), "Download URL must end in a plain file name");
  return { storage, url: url.href, sha512, filename, volid: `${storage}:vztmpl/${filename}` };
};

/** Every non-GET passes through this guard, including writes issued by the Alchemy child process. */
export async function guardedEndpoint() {
  const scope = settings();
  const download = downloadSettings();
  const endpoint = new URL(required("PROXMOX_ENDPOINT"));
  assert.equal(endpoint.protocol, "https:");
  const authorization = `PVEAPIToken=${required("PROXMOX_TOKEN_ID")}=${required("PROXMOX_TOKEN_SECRET")}`;
  const ca = process.env.PROXMOX_CA_CERT;
  const upstream = (method: string, path: string, body = "") =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        new URL(path, endpoint),
        {
          method,
          ca,
          rejectUnauthorized: true,
          headers: {
            Authorization: authorization,
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () => resolve({ status: response.statusCode ?? 500, body: text }));
        },
      );
      req.on("error", () => reject(new Error("Proxmox connection failed")));
      req.setTimeout(120_000, () => req.destroy());
      req.end(body);
    });
  const get = async (path: string): Promise<unknown> => {
    const response = await upstream("GET", `/api2/json${path}`);
    assert.equal(response.status, 200, "Guard GET failed");
    const result: unknown = JSON.parse(response.body);
    assert(object(result));
    return result.data;
  };
  const pool = async () => {
    const pools = await get(`/pools?poolid=${encodeURIComponent(scope.pool)}`);
    assert(Array.isArray(pools));
    const match = pools.find((item) => object(item) && item.poolid === scope.pool);
    assert(object(match) && Array.isArray(match.members), "Test pool membership is not visible");
    return match;
  };
  const directory = await mkdtemp(join(tmpdir(), "proxmox-live-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const cert = await readFile(join(directory, "cert.pem"), "utf8");
  let writes = 0;
  const server = createServer(
    { key: await readFile(join(directory, "key.pem")), cert },
    async (req, res) => {
      try {
        assert.equal(req.headers.authorization, authorization, "Authentication required");
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          assert(body.length < 1024 * 1024);
        }
        const method = req.method ?? "GET";
        const url = new URL(req.url ?? "/", "https://localhost");
        const storage =
          /^\/api2\/json\/nodes\/([^/]+)\/storage\/([^/]+)\/(download-url|content\/([^/]+))$/.exec(
            url.pathname,
          );
        if (method !== "GET" && storage) {
          // Only the download phase writes storage content: test-prefixed container templates on
          // the dedicated download storage.
          assert(download, "Storage writes need the download test variables");
          assert.equal(decodeURIComponent(storage[1]), scope.node, "Wrong node");
          assert.equal(decodeURIComponent(storage[2]), download.storage, "Wrong storage");
          if (storage[4] === undefined) {
            assert.equal(method, "POST");
            const form = new URLSearchParams(body);
            assert.deepEqual(form.getAll("content"), ["vztmpl"], "Only container templates");
            assert.equal(form.getAll("filename").length, 1, "Exactly one filename");
            assert(testFile(form.get("filename")), "Only test-prefixed files");
          } else {
            assert.equal(method, "DELETE");
            const volume = /^([^:]+):vztmpl\/([^/]+)$/.exec(decodeURIComponent(storage[4]));
            assert(volume && volume[1] === download.storage, "Wrong volume storage");
            assert(testFile(volume[2]), "Only test-prefixed files");
          }
          writes++;
        } else if (method !== "GET") {
          const route =
            /^\/api2\/json\/nodes\/([^/]+)\/(lxc|qemu)(?:\/(\d+)(?:\/(config|resize|status\/(?:start|stop)|agent\/(?:exec|ping)))?)?$/.exec(
              url.pathname,
            );
          assert(route, "Write outside guest lifecycle denied");
          assert.equal(decodeURIComponent(route[1]), scope.node, "Wrong node");
          const form = new URLSearchParams(body);
          const id = Number(route[3] ?? form.get("vmid"));
          assert(
            Number.isSafeInteger(id) && id >= scope.min && id <= scope.max,
            "VMID outside allowed range",
          );
          const guests = await get("/cluster/resources?type=vm");
          assert(Array.isArray(guests));
          const existing = guests.find((guest) => object(guest) && guest.vmid === id);
          if (existing) {
            assert(
              object(existing) && existing.node === scope.node && existing.type === route[2],
              "Guest identity mismatch",
            );
            const membership = await pool();
            assert(Array.isArray(membership.members));
            assert(
              membership.members.some(
                (member) => object(member) && member.vmid === id && member.type === route[2],
              ),
              "Existing guest is not a test pool member",
            );
          } else {
            assert(!route[3] && method === "POST", "Only create may write a missing guest");
            assert.equal(form.get("pool"), scope.pool, "Creation requires test pool");
          }
          writes++;
        }
        const response = await upstream(method, `${url.pathname}${url.search}`, body);
        res.writeHead(response.status, { "Content-Type": "application/json" });
        res.end(response.body);
      } catch {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: null, message: "Live test safety guard refused request" }));
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    endpoint: `https://127.0.0.1:${address.port}`,
    ca: cert,
    get,
    pool,
    writes: () => writes,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}
