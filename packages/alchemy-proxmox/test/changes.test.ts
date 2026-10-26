import { describe, expect, it } from "vitest";
import { changes, validateChanges, type GuestAttributes } from "../src/Changes.ts";
import { mergeTags, ownership, ownershipTags } from "../src/Tags.ts";

const owner = ownershipTags("Homelab", "prod");
const ownerTags = owner.join(";");
const guest = (config: Record<string, unknown>): GuestAttributes => ({
  node: "pve",
  vmid: 100,
  config,
  pending: [],
});
const declared = (config: object) => ({ node: "pve", vmid: 100, config });

describe("Proxmox plans", () => {
  it("adds only ownership when declared properties match", () => {
    const live = guest({
      hostname: "web",
      tags: "user-tag",
      onboot: 1,
      digest: "generated",
      net0: "name=eth0,ip=dhcp,hwaddr=AA:BB:CC:DD:EE:FF",
    });
    const result = changes(
      "lxc",
      declared({ hostname: "web", onboot: true, net0: { name: "eth0", ip: "dhcp" } }),
      live,
      owner,
    );
    expect(result).toEqual([
      { path: "tags", declared: `user-tag;${ownerTags}`, live: "user-tag", classification: "live" },
    ]);
    expect(() => validateChanges(result, live, owner)).not.toThrow();
  });
  it("rejects adding user tags during adoption", () => {
    const live = guest({ tags: "existing" });
    const result = changes("lxc", declared({ tags: "new-user-tag" }), live, owner);
    expect(() => validateChanges(result, live, owner)).toThrow("Adoption must change only");
  });
  it("compares structured IP configuration at arbitrary indexes", () => {
    const live = guest({ tags: ownerTags, ipconfig27: "ip=192.0.2.10/24,gw=192.0.2.1,ip6=auto" });
    expect(
      changes(
        "qemu",
        declared({ ipconfig27: { ip: "192.0.2.10/24", gw: "192.0.2.1" } }),
        live,
        owner,
      ),
    ).toEqual([]);
    expect(
      changes("qemu", declared({ ipconfig27: { ip: "dhcp" } }), live, owner)[0].classification,
    ).toBe("not-supported");
  });
  it("requires every declared config leaf to match before adoption", () => {
    const live = guest({ memory: 512 });
    const result = changes("lxc", declared({ memory: 1024 }), live, owner);
    expect(() => validateChanges(result, live, owner)).toThrow("Adoption must change only");
  });
  it("classifies live, reboot, unsupported and fixed changes without replacements", () => {
    const live = guest({
      tags: ownerTags,
      memory: "1024",
      cores: 1,
      name: "old",
      ostype: "l26",
      net0: "virtio,bridge=vmbr0,firewall=0",
    });
    const result = changes(
      "qemu",
      declared({
        memory: { current: 2048 },
        cores: 2,
        name: "new",
        ostype: "win11",
        net0: { bridge: "vmbr1", firewall: true },
      }),
      live,
      owner,
    );
    expect(Object.fromEntries(result.map((item) => [item.path, item.classification]))).toEqual({
      "memory.current": "needs-reboot",
      cores: "needs-reboot",
      name: "live",
      ostype: "fixed",
      "net0.bridge": "not-supported",
      "net0.firewall": "live",
    });
    expect(() => validateChanges(result, live, owner)).toThrow("No replacement");
  });
  it("rejects cloud-init rename, device and snippet changes", () => {
    const live = guest({
      tags: ownerTags,
      name: "old",
      ide2: "local:vm-100-cloudinit,media=cdrom",
      cicustom: "vendor=local:snippets/old.yaml",
    });
    const vm = changes(
      "qemu",
      declared({ name: "new", cicustom: "vendor=local:snippets/new.yaml" }),
      live,
      owner,
    );
    expect(vm.every((item) => item.classification === "not-supported")).toBe(true);
    const ct = changes(
      "lxc",
      declared({ dev27: { path: "/dev/net/tun" } }),
      guest({ tags: ownerTags }),
      owner,
    );
    expect(ct[0].classification).toBe("not-supported");
  });
  it("compares disk capacity and storage without guessing generated volume names", () => {
    const live = guest({ tags: ownerTags, scsi27: "local:vm-100-disk-0,size=32768M" });
    const props = { ...declared({}), disks: { scsi27: { storage: "local", sizeGiB: 32 } } };
    expect(changes("qemu", props, live, owner)).toEqual([]);
    expect(
      changes(
        "qemu",
        { ...props, disks: { scsi27: { storage: "local", sizeGiB: 64 } } },
        live,
        owner,
      )[0].classification,
    ).toBe("live");
    expect(
      changes(
        "qemu",
        { ...props, disks: { scsi27: { storage: "local", sizeGiB: 16 } } },
        live,
        owner,
      )[0].classification,
    ).toBe("fixed");
    expect(
      changes(
        "qemu",
        { ...props, disks: { scsi27: { storage: "other", sizeGiB: 32 } } },
        live,
        owner,
      )[0].classification,
    ).toBe("not-supported");
  });
  it("ignores undeclared snippet keys but compares declared ones", () => {
    const live = guest({
      tags: ownerTags,
      cicustom: "vendor=local:snippets/vendor.yaml,meta=local:snippets/migration.yaml",
    });
    expect(
      changes("qemu", declared({ cicustom: "vendor=local:snippets/vendor.yaml" }), live, owner),
    ).toEqual([]);
  });
});

describe("ownership tags", () => {
  it("uses the marker plus lowercase stack and stage names", () => {
    expect(owner).toEqual(["alchemy", "homelab", "prod"]);
    expect(ownershipTags("prod", "prod")).toEqual(["alchemy", "prod"]);
    expect(() => ownershipTags("My App", "prod")).toThrow(
      'Stack name "My App" cannot be a Proxmox tag',
    );
    expect(() => ownershipTags("homelab", "pr/42")).toThrow(
      'Stage name "pr/42" cannot be a Proxmox tag',
    );
  });
  it("counts stack and stage tags only next to the marker", () => {
    expect(ownership(undefined, owner)).toBe("unmanaged");
    expect(ownership("homelab;prod;user", owner)).toBe("unmanaged");
    expect(ownership("Alchemy;HomeLab;prod;user", owner)).toBe("owned");
    expect(ownership("alchemy;other;prod", owner)).toBe("foreign");
  });
  it("preserves user tags and adds only missing owner tags", () => {
    expect(mergeTags("user;prod", "other;user", owner)).toBe("user;prod;other;alchemy;homelab");
    expect(mergeTags("Alchemy;HomeLab;prod", undefined, owner)).toBe("Alchemy;HomeLab;prod");
    expect(() => mergeTags("invalid tag", undefined, owner)).toThrow("Invalid Proxmox tag");
  });
});
