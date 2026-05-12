import * as fs from "fs";
import * as path from "path";
import { Provider, Info } from "../src/provider";

export function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

export function parseFixture(
  name: string,
  opts?: { groups?: boolean; cMode?: boolean },
): Provider {
  const p = new Provider();
  if (opts?.groups) p.doGroups = true;
  p.parseString(fixture(name), "file:///" + name, opts?.cMode);
  return p;
}

export function findInfo(
  p: Provider,
  name: string,
  kind?: string,
): Info | undefined {
  const lower = name.toLowerCase();
  return p.funcList.find(
    (i) => i.nameCmp === lower && (kind === undefined || i.kind === kind),
  );
}

export function findAll(p: Provider, name: string, kind?: string): Info[] {
  const lower = name.toLowerCase();
  return p.funcList.filter(
    (i) => i.nameCmp === lower && (kind === undefined || i.kind === kind),
  );
}
