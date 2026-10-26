import { expect, it } from "vitest";
import { convert, FAMILY, FORMAT, type ApiNode } from "../scripts/convert.ts";

const fragment: ApiNode[] = [
  {
    path: "/nodes/{node}/lxc/{vmid}/config",
    info: {
      PUT: {
        name: "set_config",
        parameters: {
          properties: {
            node: { type: "string" },
            vmid: { type: "integer" },
            "net[n]": {
              type: "string",
              optional: 1,
              format: { name: { type: "string" }, mtu: { type: "integer", optional: 1 } },
            },
            tags: { type: "string", optional: 1, format: "pve-tag-list" },
          },
        },
        returns: { type: "null" },
      },
    },
  },
];
it("preserves property-string formats and indexed families in Smithy", () => {
  const { models, count } = convert(fragment);
  expect(count).toBe(1);
  const input = models.nodes_lxc.shapes["proxmox.nodes_lxc#PutNodesByNodeLxcByVmidConfigRequest"];
  expect(input.members?.node.traits?.["smithy.api#httpLabel"]).toEqual({});
  expect(input.members?.["net[n]"].traits?.[FORMAT]).toEqual({
    name: { type: "string" },
    mtu: { type: "integer", optional: 1 },
  });
  expect(input.members?.["net[n]"].traits?.[FAMILY]).toMatchObject({ pattern: "net[n]" });
  expect(input.members?.tags.traits?.[FORMAT]).toBe("pve-tag-list");
});
it("binds GET parameters to query and paths and preserves access metadata", () => {
  const { models } = convert([
    {
      path: "/pools/{poolid}",
      info: {
        GET: {
          name: "read",
          allowtoken: 0,
          protected: 1,
          parameters: {
            properties: {
              poolid: { type: "string" },
              type: { type: "string", optional: 1, enum: ["vm", "storage"] },
            },
          },
          returns: { type: "array", items: { type: "string" } },
        },
      },
    },
  ]);
  const shapes = models.pools.shapes;
  expect(
    shapes["proxmox.pools#GetPoolsByPoolidRequest"].members?.type.traits?.["smithy.api#httpQuery"],
  ).toBe("type");
  expect(shapes["proxmox.pools#GetPoolsByPoolid"].traits?.["proxmox.api#access"]).toMatchObject({
    allowtoken: 0,
    protected: 1,
  });
  expect(shapes["proxmox.pools#GetPoolsByPoolidRequestType"].type).toBe("enum");
});
it("keeps structure and drops every documentation text", () => {
  const prose = "Invented prose for this test only.";
  const { models } = convert([
    {
      path: "/widgets/{id}",
      info: {
        POST: {
          name: "create_widget",
          description: prose,
          permissions: { description: prose, check: ["perm", "/", ["Sys.Audit"]] },
          parameters: {
            properties: {
              id: { type: "integer", description: prose, minimum: 1 },
              "slot[n]": {
                type: "string",
                optional: 1,
                description: prose,
                verbose_description: prose,
                typetext: "<size>",
                format: {
                  size: {
                    type: "integer",
                    description: prose,
                    format_description: "size in units",
                    default: 4,
                  },
                  mode: { type: "string", enum: ["a", "b"], default: "described in words" },
                },
              },
            },
          },
          returns: { type: "null", title: prose },
        },
      },
    },
  ]);
  const shapes = models.widgets.shapes;
  const slot = {
    type: "string",
    optional: 1,
    format: {
      size: { type: "integer", default: 4 },
      mode: { type: "string", enum: ["a", "b"] },
    },
  };
  const input = shapes["proxmox.widgets#PostWidgetsByIdRequest"];
  expect(input.members?.["slot[n]"].traits?.[FORMAT]).toEqual(slot.format);
  expect(input.members?.["slot[n]"].traits?.[FAMILY]).toEqual({ pattern: "slot[n]", schema: slot });
  expect(shapes["proxmox.widgets#PostWidgetsById"].traits?.["smithy.api#documentation"]).toBe(
    "POST /widgets/{id}",
  );
  expect(JSON.stringify(models)).not.toMatch(/Invented prose|size in units|described in words/);
});
