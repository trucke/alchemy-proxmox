import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import { Container, StorageDownload, VirtualMachine, providers } from "../src/index.ts";
import { downloadSettings } from "./guard.ts";

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};
const node = required("PROXMOX_TEST_NODE");
const pool = required("PROXMOX_TEST_POOL");
const storage = required("PROXMOX_TEST_STORAGE");
const vmid = Number(required("PROXMOX_TEST_MIN_VMID"));
const phase = process.env.PROXMOX_TEST_PHASE;
const update = phase === "update";

/** The download phases declare only the test template download. */
const download = Effect.gen(function* () {
  const settings = downloadSettings();
  if (!settings) return yield* Effect.die(new Error("Download test variables are not set"));
  const url = new URL(settings.url);
  // A changed source for the same filename must fail the plan; it is never downloaded.
  if (phase === "download-changed") url.searchParams.set("alchemy-test", "changed");
  yield* StorageDownload("download", {
    node,
    storage: settings.storage,
    content: "vztmpl",
    filename: settings.filename,
    url: url.href,
    checksum: settings.sha512,
    checksumAlgorithm: "sha512",
    timeoutMinutes: 10,
  }).pipe(RemovalPolicy.destroy());
  return {};
});

export default Alchemy.Stack(
  process.env.PROXMOX_TEST_STACK ?? "proxmox-m3",
  {
    providers: providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    if (phase?.startsWith("download")) return yield* download;
    const container = Container("container", {
      node,
      vmid,
      pool,
      template: required("PROXMOX_TEST_TEMPLATE"),
      config: {
        hostname: "alchemy-test-ct",
        memory: update ? 512 : 256,
        swap: 0,
        cores: 1,
        unprivileged: true,
        ...(phase === "forbidden" ? { ostype: "alpine" } : {}),
        description: update ? "updated" : "created",
      },
      disks: { rootfs: { storage, sizeGiB: update ? 3 : 2 } },
    });
    yield* phase === "retain" ? container : container.pipe(RemovalPolicy.destroy());
    const vm = VirtualMachine("vm", {
      node,
      vmid: vmid + 1,
      pool,
      image: required("PROXMOX_TEST_IMAGE"),
      cloudInitStorage: storage,
      config: {
        name: "alchemy-test-vm",
        agent: { enabled: true },
        memory: { current: update ? 768 : 512 },
        cores: 1,
        scsihw: "virtio-scsi-single",
        boot: "order=scsi0",
        description: update ? "updated" : "created",
      },
      disks: { scsi0: { storage, sizeGiB: update ? 5 : 4 } },
    });
    yield* phase === "retain" ? vm : vm.pipe(RemovalPolicy.destroy());
    return {};
  }),
);
