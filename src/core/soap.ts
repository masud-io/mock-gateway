/**
 * SOAP support: envelope parsing/wrapping, Faults, and WSDL import (operations + sample responses from the XSD).
 * Pure functions: no framework or database imports.
 */
import { XMLParser, XMLValidator } from "fast-xml-parser";

export type SoapVersion = "1.1" | "1.2";

const NS = {
  "1.1": "http://schemas.xmlsoap.org/soap/envelope/",
  "1.2": "http://www.w3.org/2003/05/soap-envelope",
} as const;

export const soapContentType = (v: SoapVersion) => (v === "1.2" ? "application/soap+xml; charset=utf-8" : "text/xml; charset=utf-8");

export const escapeXml = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// Namespace prefixes are dropped so templates and matchers can say request.body.GetOrder.OrderId whatever prefix the client used.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false, // keep "007" as "007"
  parseAttributeValue: false,
  trimValues: true,
});

export interface SoapRequest {
  version: SoapVersion;
  /** Local name of the first element in the Body */
  operation: string;
  soapAction: string | null;
  /** The Body content as an object, e.g. { GetOrder: { OrderId: "7" } } */
  body: Record<string, unknown>;
}

const stripQuotes = (s: string) => s.trim().replace(/^"(.*)"$/, "$1");

export function parseEnvelope(raw: string, headers: Record<string, string>): SoapRequest | { error: string } {
  if (!raw.trim()) return { error: "The request body is empty: a SOAP request must POST an XML envelope." };
  const valid = XMLValidator.validate(raw);
  if (valid !== true) return { error: `The request is not well-formed XML: ${valid.err.msg} (line ${valid.err.line})` };
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(raw);
  } catch (e) {
    return { error: `The request XML could not be read: ${(e as Error).message}` };
  }
  const env = doc.Envelope as Record<string, unknown> | undefined;
  if (!env || typeof env !== "object") return { error: "The XML is not a SOAP envelope (no Envelope root element)." };
  const version: SoapVersion = raw.includes(NS["1.2"]) ? "1.2" : "1.1";
  const body = env.Body;
  if (body === undefined) return { error: "The SOAP envelope has no Body." };
  const content = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const operation = Object.keys(content).find((k) => !k.startsWith("@_") && k !== "#text");
  if (!operation) return { error: "The SOAP Body is empty: there is no operation element." };

  let soapAction = headers["soapaction"] !== undefined ? stripQuotes(headers["soapaction"]) : null;
  if (soapAction === null) {
    const m = /action="?([^";]+)"?/i.exec(headers["content-type"] ?? "");
    if (m) soapAction = m[1].trim();
  }
  const clean: Record<string, unknown> = {};
  clean[operation] = content[operation];
  return { version, operation, soapAction, body: clean };
}

const isEnvelope = (xml: string) => /^\s*(<\?xml[^>]*\?>\s*)?<([\w.-]+:)?Envelope[\s>]/.test(xml);

/** Wrap Body content in an envelope; a response that already is a complete envelope is passed through as written. */
export function wrapEnvelope(version: SoapVersion, inner: string): string {
  if (isEnvelope(inner)) return inner;
  const content = inner.replace(/^\s*<\?xml[^>]*\?>\s*/, "");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<soap:Envelope xmlns:soap="${NS[version]}">\n  <soap:Body>\n${content}\n  </soap:Body>\n</soap:Envelope>`;
}

/** The <soap:Fault> element for either SOAP version. `code`: Client (the caller's fault) or Server. */
export function faultXml(version: SoapVersion, code: string, message: string, detail?: string): string {
  const client = /^(client|sender)$/i.test(code);
  const m = escapeXml(message);
  if (version === "1.2") {
    return `<soap:Fault><soap:Code><soap:Value>soap:${client ? "Sender" : /^(server|receiver)$/i.test(code) ? "Receiver" : escapeXml(code)}</soap:Value></soap:Code><soap:Reason><soap:Text xml:lang="en">${m}</soap:Text></soap:Reason>${detail ? `<soap:Detail>${detail}</soap:Detail>` : ""}</soap:Fault>`;
  }
  const c = client ? "Client" : /^(server|receiver)$/i.test(code) ? "Server" : escapeXml(code);
  return `<soap:Fault><faultcode>${/:/.test(c) ? c : `soap:${c}`}</faultcode><faultstring>${m}</faultstring>${detail ? `<detail>${detail}</detail>` : ""}</soap:Fault>`;
}

/** A complete fault response body */
export const faultEnvelope = (version: SoapVersion, code: string, message: string) => wrapEnvelope(version, faultXml(version, code, message));

// ======================= WSDL import =======================

type Node = Record<string, unknown>;
const arr = <T,>(x: T | T[] | undefined): T[] => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const local = (s: unknown) => String(s ?? "").replace(/^.*:/, "");
const attr = (n: Node | undefined, k: string) => (n ? (n[`@_${k}`] as string | undefined) : undefined);

export interface WsdlOperation {
  name: string;
  soapAction: string | null;
  /** Body content for the response, with generated values as template tokens */
  sampleResponse: string;
  /** Body content for a request, for the Try-it panel */
  sampleRequest: string;
}
export interface Wsdl {
  version: SoapVersion;
  serviceName: string | null;
  targetNamespace: string | null;
  operations: WsdlOperation[];
  warnings: string[];
}

const wsdlParser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, trimValues: true,
  isArray: (name) => ["element", "complexType", "simpleType", "schema", "message", "part", "portType", "binding", "operation", "enumeration", "attribute"].includes(name),
});

/** Parse a WSDL 1.1 document into operations. Throws a readable Error when it isn't one. */
export function parseWsdl(text: string): Wsdl {
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new Error(`Not well-formed XML: ${valid.err.msg} (line ${valid.err.line})`);
  const rawDefs = (wsdlParser.parse(text) as Node).definitions;
  const defs: Node | undefined = rawDefs === undefined ? undefined : typeof rawDefs === "object" && rawDefs !== null ? (rawDefs as Node) : {}; // an empty <definitions/> parses to ""
  if (!defs) {
    if (/<(\w+:)?description[\s>]/.test(text)) throw new Error("This is a WSDL 2.0 document; only WSDL 1.1 is supported.");
    throw new Error("This is not a WSDL document (no definitions element).");
  }
  const warnings: string[] = [];
  const version: SoapVersion = text.includes("http://schemas.xmlsoap.org/wsdl/soap12/") && !text.includes("http://schemas.xmlsoap.org/wsdl/soap/") ? "1.2" : "1.1";
  const tns = attr(defs, "targetNamespace") ?? null;

  // Collect every schema's elements and types, by local name
  const elements = new Map<string, { node: Node; ns: string | null }>();
  const complex = new Map<string, Node>();
  const simple = new Map<string, Node>();
  const typesNode = defs.types as Node | undefined;
  const schemas = arr(typesNode?.schema as Node | Node[] | undefined);
  for (const s of schemas) {
    const ns = attr(s, "targetNamespace") ?? tns;
    for (const e of arr(s.element as Node[] | undefined)) elements.set(attr(e, "name") ?? "", { node: e, ns });
    for (const t of arr(s.complexType as Node[] | undefined)) complex.set(attr(t, "name") ?? "", t);
    for (const t of arr(s.simpleType as Node[] | undefined)) simple.set(attr(t, "name") ?? "", t);
    if (s.import) warnings.push("The schema imports other files, which aren't fetched: elements defined there get a placeholder.");
  }
  if (!schemas.length && !typesNode) warnings.push("The WSDL has no inline types, so sample responses are empty placeholders.");

  const messages = new Map<string, Node>();
  for (const m of arr(defs.message as Node[] | undefined)) messages.set(attr(m, "name") ?? "", m);

  const actions = new Map<string, string>();
  for (const b of arr(defs.binding as Node[] | undefined)) {
    for (const op of arr(b.operation as Node[] | undefined)) {
      const soapOp = op.operation as Node | undefined; // <soap:operation soapAction="…"/>
      const a = soapOp ? attr(Array.isArray(soapOp) ? (soapOp[0] as Node) : soapOp, "soapAction") : undefined;
      const n = attr(op, "name");
      if (n && !actions.has(n)) actions.set(n, a ?? "");
    }
  }

  const sample = (messageRef: string | undefined, opName: string, suffix: string): string => {
    const msg = messages.get(local(messageRef));
    const part = arr(msg?.part as Node[] | undefined)[0];
    const elName = local(attr(part, "element"));
    if (elName) {
      const found = elements.get(elName);
      if (!found) return `<${elName}/>`;
      return genElement(found.node, found.ns, true, 0, { elements, complex, simple });
    }
    // RPC style: wrapper named after the operation
    return `<${opName}${suffix}/>`;
  };

  const ops: WsdlOperation[] = [];
  const seen = new Set<string>();
  for (const pt of arr(defs.portType as Node[] | undefined)) {
    for (const op of arr(pt.operation as Node[] | undefined)) {
      const name = attr(op, "name");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const input = op.input as Node | undefined;
      const output = op.output as Node | undefined;
      ops.push({
        name,
        soapAction: actions.has(name) ? actions.get(name) || null : null,
        sampleRequest: sample(attr(input, "message"), name, ""),
        sampleResponse: sample(attr(output, "message"), name, "Response"),
      });
    }
  }
  if (!ops.length) throw new Error("The WSDL declares no operations (no portType operations).");

  const svc = arr(defs.service as Node | Node[] | undefined)[0];
  return { version, serviceName: attr(svc, "name") ?? null, targetNamespace: tns, operations: ops, warnings: [...new Set(warnings)] };
}

interface Schema {
  elements: Map<string, { node: Node; ns: string | null }>;
  complex: Map<string, Node>;
  simple: Map<string, Node>;
}
const MAX_DEPTH = 8;

function builtinSample(type: string): string {
  switch (type) {
    case "boolean": return "true";
    case "int": case "integer": case "long": case "short": case "byte": case "decimal": case "positiveInteger": case "nonNegativeInteger":
    case "unsignedInt": case "unsignedLong": case "unsignedShort": case "unsignedByte": return "0";
    case "float": case "double": return "0.0";
    case "date": return "2024-01-01";
    case "dateTime": return "{{now}}";
    case "time": return "12:00:00";
    case "base64Binary": return "AAAA";
    case "anyURI": return "https://example.com";
    default: return "string";
  }
}

function simpleValue(typeName: string | undefined, inline: Node | undefined, s: Schema): string {
  const st = inline ?? (typeName ? s.simple.get(local(typeName)) : undefined);
  const r = arr(st?.restriction as Node | Node[] | undefined)[0];
  if (r) {
    const en = arr(r.enumeration as Node[] | undefined)[0];
    if (en) return attr(en, "value") ?? "string";
    return builtinSample(local(attr(r, "base")));
  }
  return builtinSample(local(typeName));
}

/** Elements of a sequence/all, or the first alternative of a choice; nested groups are followed. */
function groupElements(g: Node, isChoice: boolean, out: Node[]) {
  const els = arr(g.element as Node[] | undefined);
  out.push(...(isChoice ? els.slice(0, 1) : els));
  if (isChoice && els.length) return;
  for (const k of ["sequence", "all", "choice"]) {
    for (const sub of arr(g[k] as Node | Node[] | undefined)) groupElements(sub, k === "choice", out);
  }
}

/** Child elements of a complexType, in declaration order (an extension's base type comes first). */
function complexChildren(ct: Node, s: Schema, depth = 0): Node[] {
  const out: Node[] = [];
  const ext = arr((ct.complexContent as Node | undefined)?.extension as Node | Node[] | undefined)[0];
  if (ext && depth < MAX_DEPTH) {
    const base = s.complex.get(local(attr(ext, "base")));
    if (base) out.push(...complexChildren(base, s, depth + 1));
  }
  const container = ext ?? ct;
  for (const k of ["sequence", "all", "choice"]) {
    for (const g of arr(container[k] as Node | Node[] | undefined)) groupElements(g, k === "choice", out);
  }
  return out;
}

function genElement(el: Node, ns: string | null, root: boolean, depth: number, s: Schema): string {
  let node = el;
  const ref = attr(el, "ref");
  if (ref) {
    const found = s.elements.get(local(ref));
    if (!found) return `<${local(ref)}/>`;
    node = found.node;
  }
  const name = attr(node, "name") ?? "Element";
  const xmlns = root && ns ? ` xmlns="${escapeXml(ns)}"` : "";
  if (depth > MAX_DEPTH) return `<${name}${xmlns}/>`;

  const typeName = attr(node, "type");
  const inlineSimple = arr(node.simpleType as Node[] | undefined)[0];
  const complex = arr(node.complexType as Node[] | undefined)[0] ?? (typeName ? s.complex.get(local(typeName)) : undefined);
  if (complex) {
    const kids = complexChildren(complex, s);
    if (!kids.length) return `<${name}${xmlns}/>`;
    const pad = "  ".repeat(depth + 1);
    const inner = kids.map((k) => pad + genElement(k, ns, false, depth + 1, s)).join("\n");
    return `<${name}${xmlns}>\n${inner}\n${"  ".repeat(depth)}</${name}>`;
  }
  if (!typeName && !inlineSimple) return `<${name}${xmlns}>string</${name}>`;
  return `<${name}${xmlns}>${simpleValue(typeName, inlineSimple, s)}</${name}>`;
}
