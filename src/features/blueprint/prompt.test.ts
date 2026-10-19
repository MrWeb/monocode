import { describe, expect, it } from "vitest";
import type { Blueprint, BlueprintNode } from "./blueprint";
import { blueprintFromCodePrompt, blueprintPrompt } from "./prompt";

const node = (id: string, title: string, instructions = ""): BlueprintNode => ({
  id,
  x: 0,
  y: 0,
  kind: "service",
  shape: "rectangle",
  line: "solid",
  title,
  instructions,
  color: "#000",
});

const bp: Blueprint = {
  version: 1,
  nodes: [
    node("ui", "Orders page", "List orders"),
    node("svc", "OrderService", "Validates and saves orders"),
    node("db", "Database"),
    node("mail", "Mailer"),
  ],
  edges: [
    {
      id: "1",
      source: "ui",
      target: "svc",
      label: "calls",
      line: "solid",
      color: "",
    },
    {
      id: "2",
      source: "svc",
      target: "db",
      label: "",
      line: "solid",
      color: "",
    },
    {
      id: "3",
      source: "svc",
      target: "mail",
      label: "notify",
      line: "dashed",
      color: "",
    },
  ],
};

// The brief is what keeps the agent from inventing structure: every box and
// arrow must reach it, it must be told to plan first and wait, and a
// selection must not leak unselected boxes in as work to do.
describe("blueprintPrompt", () => {
  it("lists every box with its instructions and every arrow", () => {
    const text = blueprintPrompt(bp);
    for (const t of ["Orders page", "OrderService", "Database", "Mailer"])
      expect(text).toContain(t);
    expect(text).toContain("Validates and saves orders");
    expect(text).toContain('[B1] Orders page → [B2] OrderService — "calls"');
    expect(text).toContain("(dashed)");
  });

  it("asks for a TODO plan and approval before any code", () => {
    const text = blueprintPrompt(bp);
    expect(text).toContain("TODO plan");
    expect(text).toContain("wait for my approval before writing any code");
    expect(text).toContain("do not add, merge, split, rename or drop");
  });

  it("scopes to the selection and lists neighbours as context only", () => {
    const text = blueprintPrompt(bp, new Set(["svc"]));
    const [work, rest] = text.split("## Connected boxes");
    expect(work).toContain("### [B1] OrderService");
    expect(work).not.toContain("### [B2]");
    expect(rest).toContain("Orders page");
    expect(rest).toContain("Database");
    expect(rest).toContain("Mailer");
  });

  it("drops arrows that do not touch the selection", () => {
    const text = blueprintPrompt(bp, new Set(["db"]));
    expect(text).toContain("OrderService");
    expect(text).not.toContain("Orders page");
    expect(text).not.toContain("Mailer");
  });
});

// The agent writes the file the canvas loads, so the brief must spell out
// the exact path and format; otherwise the drawing would fail to open.
describe("blueprintFromCodePrompt", () => {
  it("names the file and every box kind the canvas accepts", () => {
    const text = blueprintFromCodePrompt();
    expect(text).toContain(".monocode/blueprint.json");
    expect(text).toContain('"version": 1');
    for (const kind of [
      "screen",
      "component",
      "service",
      "db",
      "api",
      "queue",
      "external",
      "general",
    ])
      expect(text).toContain(`"${kind}"`);
  });

  it("forbids inventing components and touching other files", () => {
    const text = blueprintFromCodePrompt();
    expect(text).toContain("Do not invent components");
    expect(text).toContain("Do not change any other file");
  });
});
