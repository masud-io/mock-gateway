/* eslint-disable @typescript-eslint/no-explicit-any -- parsed XML is asserted loosely on purpose */
import { describe, expect, it } from "vitest";
import { buildXmlTemplate } from "./infer";
import { faultEnvelope, parseEnvelope, parseWsdl, wrapEnvelope } from "./soap";
import { checkTemplate, renderTemplate } from "./template";
import { pointWsdlAt } from "./engine";

const env11 = (body: string) =>
  `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:o="urn:orders"><soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
const env12 = (body: string) => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${body}</s:Body></s:Envelope>`;

describe("parseEnvelope", () => {
  it("reads the operation and body, whatever prefixes the client used", () => {
    const r = parseEnvelope(env11("<o:GetOrder><o:OrderId>007</o:OrderId></o:GetOrder>"), { soapaction: '"urn:orders/GetOrder"' }) as any;
    expect(r.version).toBe("1.1");
    expect(r.operation).toBe("GetOrder");
    expect(r.soapAction).toBe("urn:orders/GetOrder");
    expect(r.body).toEqual({ GetOrder: { OrderId: "007" } }); // "007" stays a string
  });
  it("detects SOAP 1.2 and takes the action from Content-Type", () => {
    const r = parseEnvelope(env12("<Ping/>"), { "content-type": 'application/soap+xml; charset=utf-8; action="urn:ping"' }) as any;
    expect(r.version).toBe("1.2");
    expect(r.operation).toBe("Ping");
    expect(r.soapAction).toBe("urn:ping");
  });
  it("explains why a request is rejected", () => {
    expect((parseEnvelope("", {}) as any).error).toMatch(/empty/);
    expect((parseEnvelope("<a><b></a>", {}) as any).error).toMatch(/well-formed/);
    expect((parseEnvelope("<a>1</a>", {}) as any).error).toMatch(/not a SOAP envelope/);
    expect((parseEnvelope(env11(""), {}) as any).error).toMatch(/Body is empty/);
  });
});

describe("envelopes and faults", () => {
  it("wraps Body content, but passes a complete envelope through untouched", () => {
    expect(wrapEnvelope("1.1", "<X/>")).toContain('<soap:Body>\n<X/>\n  </soap:Body>');
    expect(wrapEnvelope("1.2", "<X/>")).toContain("http://www.w3.org/2003/05/soap-envelope");
    const full = env11("<X/>");
    expect(wrapEnvelope("1.1", full)).toBe(full);
  });
  it("writes the right Fault for each version", () => {
    expect(faultEnvelope("1.1", "Client", "Bad <thing>")).toContain("<faultcode>soap:Client</faultcode><faultstring>Bad &lt;thing&gt;</faultstring>");
    const f12 = faultEnvelope("1.2", "Server", "Boom");
    expect(f12).toContain("<soap:Value>soap:Receiver</soap:Value>");
    expect(f12).toContain('<soap:Text xml:lang="en">Boom</soap:Text>');
  });
  it("{{soapFault}} and {{xml}} render in templates", () => {
    const ctx = (v: "1.1" | "1.2", body: unknown) => ({ request: { method: "POST", path: "/", params: {}, query: {}, headers: {}, body, rawBody: "" }, vars: {}, scenario: null, soapVersion: v });
    expect(renderTemplate('{{soapFault "Client" "Insufficient balance"}}', ctx("1.1", null))).toContain("<faultstring>Insufficient balance</faultstring>");
    expect(renderTemplate('{{soapFault "Client" "x"}}', ctx("1.2", null))).toContain("<soap:Reason>");
    expect(renderTemplate("<a>{{xml request.body.v}}</a>", ctx("1.1", { v: "a<b&c" }))).toBe("<a>a&lt;b&amp;c</a>");
  });
});

const WSDL = `<?xml version="1.0"?>
<definitions name="Orders" targetNamespace="urn:orders" xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="urn:orders" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <types>
    <xsd:schema targetNamespace="urn:orders" elementFormDefault="qualified">
      <xsd:element name="GetOrderRequest"><xsd:complexType><xsd:sequence><xsd:element name="OrderId" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="GetOrderResponse"><xsd:complexType><xsd:sequence><xsd:element name="Order" type="tns:Order"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="CancelOrderRequest"><xsd:complexType><xsd:sequence><xsd:element name="OrderId" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="CancelOrderResponse" type="xsd:boolean"/>
      <xsd:complexType name="Base"><xsd:sequence><xsd:element name="Id" type="xsd:int"/></xsd:sequence></xsd:complexType>
      <xsd:complexType name="Order">
        <xsd:complexContent><xsd:extension base="tns:Base"><xsd:sequence>
          <xsd:element name="Status" type="tns:Status"/>
          <xsd:element name="Created" type="xsd:dateTime"/>
          <xsd:element name="Lines" maxOccurs="unbounded"><xsd:complexType><xsd:sequence><xsd:element name="Sku" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>
          <xsd:choice><xsd:element name="Card" type="xsd:string"/><xsd:element name="Cash" type="xsd:string"/></xsd:choice>
        </xsd:sequence></xsd:extension></xsd:complexContent>
      </xsd:complexType>
      <xsd:simpleType name="Status"><xsd:restriction base="xsd:string"><xsd:enumeration value="NEW"/><xsd:enumeration value="PAID"/></xsd:restriction></xsd:simpleType>
    </xsd:schema>
  </types>
  <message name="GetOrderIn"><part name="parameters" element="tns:GetOrderRequest"/></message>
  <message name="GetOrderOut"><part name="parameters" element="tns:GetOrderResponse"/></message>
  <message name="CancelIn"><part name="parameters" element="tns:CancelOrderRequest"/></message>
  <message name="CancelOut"><part name="parameters" element="tns:CancelOrderResponse"/></message>
  <portType name="OrdersPort">
    <operation name="GetOrder"><input message="tns:GetOrderIn"/><output message="tns:GetOrderOut"/></operation>
    <operation name="CancelOrder"><input message="tns:CancelIn"/><output message="tns:CancelOut"/></operation>
  </portType>
  <binding name="OrdersBinding" type="tns:OrdersPort">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="GetOrder"><soap:operation soapAction="urn:orders/GetOrder"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
    <operation name="CancelOrder"><soap:operation soapAction=""/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
  </binding>
  <service name="OrdersService"><port name="OrdersPort" binding="tns:OrdersBinding"><soap:address location="http://real.example.com/orders"/></port></service>
</definitions>`;

describe("parseWsdl", () => {
  it("lists operations with their SOAPAction and builds sample responses from the schema", () => {
    const w = parseWsdl(WSDL);
    expect(w.version).toBe("1.1");
    expect(w.serviceName).toBe("OrdersService");
    expect(w.operations.map((o) => [o.name, o.soapAction])).toEqual([["GetOrder", "urn:orders/GetOrder"], ["CancelOrder", null]]);
    const get = w.operations[0].sampleResponse;
    expect(get).toContain('<GetOrderResponse xmlns="urn:orders">');
    expect(get).toContain("<Id>0</Id>"); // inherited from the base type, first
    expect(get).toContain("<Status>NEW</Status>"); // first enumeration value
    expect(get).toContain("<Created>{{now}}</Created>");
    expect(get).toContain("<Sku>string</Sku>");
    expect(get).toContain("<Card>string</Card>");
    expect(get).not.toContain("<Cash>"); // a choice contributes its first alternative
    expect(get.indexOf("<Id>")).toBeLessThan(get.indexOf("<Status>"));
    expect(checkTemplate(get)).toBeNull();
    expect(w.operations[0].sampleRequest).toContain("<OrderId>string</OrderId>");
    expect(w.operations[1].sampleResponse).toBe('<CancelOrderResponse xmlns="urn:orders">true</CancelOrderResponse>');
  });
  it("rejects what isn't a usable WSDL", () => {
    expect(() => parseWsdl("<a><b></a>")).toThrow(/well-formed/);
    expect(() => parseWsdl("<html/>")).toThrow(/not a WSDL/);
    expect(() => parseWsdl('<description xmlns="http://www.w3.org/ns/wsdl"/>')).toThrow(/WSDL 2.0/);
    expect(() => parseWsdl('<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"/>')).toThrow(/no operations/);
  });
  it("points the service address at the mock", () => {
    const out = pointWsdlAt(WSDL, "http://127.0.0.1:3000/mock/a/b/c");
    expect(out).toContain('<soap:address location="http://127.0.0.1:3000/mock/a/b/c"/>');
    expect(out).not.toContain("real.example.com");
  });
});

describe("buildXmlTemplate", () => {
  it("links echoed fields to the request and generates timestamps and ids", () => {
    const req = (parseEnvelope(env11("<o:Pay><o:Amount>42.50</o:Amount><o:Note>a &amp; b</o:Note></o:Pay>"), {}) as any).body;
    const { template, substitutions } = buildXmlTemplate(
      `<PayResponse><Amount>42.50</Amount><Note>a &amp; b</Note><Ref>7c9e6679-7425-40de-944b-e07fc1f90ae7</Ref><At>2024-05-01T10:00:00Z</At><Status>OK</Status></PayResponse>`,
      req,
    );
    expect(substitutions.map((s) => s.at).sort()).toEqual(["Amount", "At", "Note", "Ref"]);
    expect(checkTemplate(template)).toBeNull();
    const out = renderTemplate(template, { request: { method: "POST", path: "/", params: {}, query: {}, headers: {}, body: { Pay: { Amount: "9.99", Note: "x<y" } }, rawBody: "" }, vars: {}, scenario: null });
    expect(out).toContain("<Amount>9.99</Amount>");
    expect(out).toContain("<Note>x&lt;y</Note>");
    expect(out).toContain("<Status>OK</Status>");
    expect(out).not.toContain("2024-05-01T10:00:00Z");
  });
});
