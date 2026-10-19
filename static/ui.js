// Shared presentation primitives. Domain rules and application state stay outside this module.
export function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
export function button(text, fn, cls = "secondary", symbol) {
  const control = el("button", null, cls);
  control.type = "button";
  if (symbol) control.append(icon(symbol));
  if (text) control.append(document.createTextNode(text));
  control.onclick = fn;
  return control;
}
export function link(text, href, cls = "") {
  const anchor = el("a", text, cls);
  try {
    const url = new URL(href, location.href);
    if (!["https:", "http:"].includes(url.protocol)) return el("span", text);
    anchor.href = url.href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  } catch {
    return el("span", text);
  }
  return anchor;
}
export function inputField(
  form,
  label,
  name,
  value = "",
  type = "text",
  attrs = {},
) {
  const wrap = el("label", label);
  const input = el("input");
  Object.assign(input, { name, type, value, ...attrs });
  wrap.append(input);
  form.append(wrap);
  return input;
}
export function selectField(form, label, name, options, value) {
  const wrap = el("label", label);
  const select = el("select");
  select.name = name;
  for (const option of options) {
    const [key, text] = Array.isArray(option) ? option : [option, option];
    select.add(new Option(text, key));
  }
  if (value != null) select.value = value;
  wrap.append(select);
  form.append(wrap);
  return select;
}
export function formSection(title, description) {
  const section = el("fieldset", null, "form-section");
  section.append(el("legend", title));
  if (description) section.append(el("p", description, "assumptions"));
  return section;
}
