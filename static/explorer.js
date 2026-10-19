const THREE_URL = "https://esm.sh/three@0.170.0";
const CONTROLS_URL =
  "https://esm.sh/three@0.170.0/examples/jsm/controls/OrbitControls.js";
const CONNECTORS = {
  NACS: {
    title: "NACS / SAE J3400",
    short: "NACS",
    color: "#68736b",
    power: "AC or DC, depending on the equipment and vehicle",
    detail:
      "A compact interface whose two main power contacts serve AC or DC. A matching shape alone does not guarantee access to a charging network or support for an adapter.",
    contacts:
      "Two main power contacts, protective earth, control pilot and proximity contacts are represented schematically.",
    safety:
      "The charging equipment and vehicle must negotiate a supported charging mode before energy flows.",
    pins: [
      [-0.32, 0.2, 0.2],
      [0.32, 0.2, 0.2],
      [0, -0.33, 0.13],
      [-0.28, -0.5, 0.075],
      [0.28, -0.5, 0.075],
    ],
  },
  J1772: {
    title: "SAE J1772",
    short: "J1772",
    color: "#818a83",
    power: "AC charging; commonly North American Level 1 and Level 2",
    detail:
      "The vehicle’s onboard charger converts AC into DC for its battery. J1772 by itself does not provide the additional DC power contacts used by CCS1.",
    contacts:
      "Five contacts represent AC power, protective earth and the control/proximity signals. Positions are simplified, not a wiring guide.",
    safety:
      "The latch and signaling help coordinate connection and safe charging. Never modify a connector or bypass its safety features.",
    pins: [
      [-0.32, 0.28, 0.18],
      [0.32, 0.28, 0.18],
      [0, -0.25, 0.18],
      [-0.35, -0.4, 0.08],
      [0.35, -0.4, 0.08],
    ],
  },
  CCS1: {
    title: "CCS Combo 1",
    short: "CCS1",
    color: "#858377",
    power: "DC fast charging through the lower pair of power contacts",
    detail:
      "CCS1 combines a J1772-style upper interface with two larger DC contacts below. A compatible vehicle inlet can accept J1772 AC or CCS1 DC; an AC-only J1772 inlet cannot accept a CCS1 plug.",
    contacts:
      "The upper signal/AC interface and lower DC pair are shown as a simplified combined form. Not every contact is populated or used in every cable.",
    safety:
      "DC charging bypasses the onboard AC charger. Vehicle, cable and charger limits still determine actual power.",
    pins: [
      [-0.3, 0.32, 0.15],
      [0.3, 0.32, 0.15],
      [0, -0.06, 0.14],
      [-0.3, -0.2, 0.07],
      [0.3, -0.2, 0.07],
      [-0.31, -0.87, 0.21],
      [0.31, -0.87, 0.21],
    ],
  },
  CHAdeMO: {
    title: "CHAdeMO",
    short: "CHAdeMO",
    color: "#757d7b",
    power: "DC charging using a dedicated connector",
    detail:
      "A DC charging interface used by certain vehicles and stations. A vehicle may have a separate AC inlet. Availability and compatibility vary by vehicle, market and charging site.",
    contacts:
      "Large power contacts and smaller communication/safety contacts are suggested here, not reproduced as an engineering pinout.",
    safety:
      "Connector locking and communication are part of safe operation. Bidirectional charging requires specifically compatible vehicles and equipment; the plug alone does not establish support.",
    pins: [
      [-0.31, 0.04, 0.22],
      [0.31, 0.04, 0.22],
      [-0.3, 0.44, 0.07],
      [0, 0.48, 0.07],
      [0.3, 0.44, 0.07],
      [-0.35, -0.37, 0.07],
      [0, -0.43, 0.07],
      [0.35, -0.37, 0.07],
    ],
  },
};
let instanceNumber = 0;

function connectorSVG(name, x, y, scale = 1) {
  const item = CONNECTORS[name];
  const extra =
    name === "CCS1"
      ? '<rect x="-61" y="27" width="122" height="83" rx="30" fill="#343b37" stroke="currentColor" stroke-width="3"/>'
      : "";
  const contacts = item.pins
    .map(
      ([px, py, radius]) =>
        `<circle cx="${px * 100}" cy="${-py * 100}" r="${radius * 100}" fill="#dce1dc" stroke="#202622" stroke-width="5"/>`,
    )
    .join("");
  const outline =
    name === "NACS"
      ? '<path d="M-49-42Q-49-66-23-66H23Q49-66 49-42V37Q49 65 23 65H-23Q-49 65-49 37Z" fill="#343b37" stroke="currentColor" stroke-width="5"/>'
      : `<ellipse rx="${name === "CHAdeMO" ? 75 : 66}" ry="${name === "CHAdeMO" ? 75 : 68}" fill="#343b37" stroke="currentColor" stroke-width="5"/>`;
  const latch =
    name === "CHAdeMO"
      ? '<path d="M-79-32H-91V44H-77M79-32H91V44H77" fill="none" stroke="currentColor" stroke-width="9"/>'
      : '<rect x="-18" y="-79" width="36" height="12" rx="5" fill="currentColor"/>';
  return `<g transform="translate(${x} ${y}) scale(${scale})" style="color:${item.color}"><path d="M-24 60V136Q-24 154 0 154H22V202" fill="none" stroke="#616b65" stroke-width="24"/>${extra}${outline}${contacts}${latch}</g>`;
}

function diagramSVG(primary, secondary, compare, mode) {
  let drawing;
  if (mode === "port") {
    drawing =
      '<path d="M55 206V162L101 145L132 98H265L310 145H347V206Z" fill="#343b37" stroke="currentColor" stroke-width="4"/><circle cx="124" cy="206" r="29" fill="#616b65"/><circle cx="286" cy="206" r="29" fill="#616b65"/><rect x="302" y="152" width="28" height="28" rx="6" fill="#c5cec2"/><path d="M330 166H381" stroke="currentColor" stroke-width="4" stroke-dasharray="7 7"/><rect x="387" y="141" width="48" height="50" rx="8" fill="#616b65" stroke="currentColor" stroke-width="3"/><path d="M435 166H476" stroke="currentColor" stroke-width="4" stroke-dasharray="7 7"/>' +
      connectorSVG(primary, 548, 153, 0.66) +
      '<text x="192" y="279" text-anchor="middle">Generic vehicle inlet</text><text x="412" y="119" text-anchor="middle">Adapter?</text><text x="412" y="279" text-anchor="middle">Compatibility must be verified</text>';
  } else if (mode === "scene") {
    drawing =
      '<rect x="65" y="53" width="136" height="203" rx="17" fill="#343b37" stroke="currentColor" stroke-width="4"/><rect x="86" y="75" width="94" height="65" rx="8" fill="#c5cec2"/><text x="133" y="113" text-anchor="middle" fill="#202622">EV</text><path d="M200 113Q270 100 264 196T337 178" fill="none" stroke="#727c75" stroke-width="9"/><path d="M327 217V165L374 145L407 106H518L552 145H583V217Z" fill="#343b37" stroke="currentColor" stroke-width="4"/><circle cx="382" cy="217" r="27" fill="#616b65"/><circle cx="529" cy="217" r="27" fill="#616b65"/><text x="133" y="290" text-anchor="middle">Generic charger</text><text x="456" y="290" text-anchor="middle">Park · connect · authorize · charge</text>';
  } else if (mode === "exploded") {
    drawing =
      '<path d="M74 163H554" stroke="currentColor" stroke-width="2" stroke-dasharray="6 8"/><rect x="84" y="108" width="74" height="110" rx="28" fill="#616b65" stroke="currentColor" stroke-width="3"/><ellipse cx="287" cy="163" rx="47" ry="61" fill="#343b37" stroke="currentColor" stroke-width="3"/>' +
      connectorSVG(primary, 465, 143, 0.78) +
      '<text x="121" y="286" text-anchor="middle">Outer grip</text><text x="287" y="286" text-anchor="middle">Insulating body</text><text x="474" y="286" text-anchor="middle">Contact face</text>';
  } else {
    drawing = compare
      ? connectorSVG(primary, 208, 126, 0.83) +
        connectorSVG(secondary, 440, 126, 0.83) +
        `<text x="208" y="323" text-anchor="middle">${CONNECTORS[primary].short}</text><text x="440" y="323" text-anchor="middle">${CONNECTORS[secondary].short}</text>`
      : connectorSVG(primary, 320, 125, 0.91) +
        `<text x="320" y="329" text-anchor="middle">${CONNECTORS[primary].title}</text>`;
  }
  return `<svg viewBox="0 0 640 355" role="img" aria-label="Original simplified ${mode} diagram, not an engineering drawing" xmlns="http://www.w3.org/2000/svg">${drawing}</svg>`;
}

/** Mount an independent educational panel. No station data or credentials are used. */
export async function mountExplorer(container) {
  const prefix = `connector-explorer-${++instanceNumber}`;
  if (!document.querySelector("link[data-connector-explorer]")) {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("./explorer.css", import.meta.url).href;
    stylesheet.dataset.connectorExplorer = "";
    document.head.append(stylesheet);
  }
  const root = document.createElement("section");
  root.className = "explorer";
  root.setAttribute("aria-label", "Connector illustrations and charging guide");
  const options = Object.entries(CONNECTORS)
    .map(([name, item]) => `<option value="${name}">${item.title}</option>`)
    .join("");
  root.innerHTML = `
    <header class="explorer__header"><p>Compare connector types and explore how charging works. Original diagrams and 3D models are simplified illustrations—not verified product geometry, pinouts or vehicle specifications.</p></header>
    <div class="explorer__selectors">
      <label for="${prefix}-primary">Connector<select id="${prefix}-primary" data-role="primary">${options}</select></label>
      <label for="${prefix}-mode">View<select id="${prefix}-mode" data-role="mode"><option value="connector">Connector face</option><option value="exploded">Separated-parts schematic</option><option value="port">Vehicle inlet & adapter</option><option value="scene">Charging introduction</option></select></label>
      <label class="explorer__check"><input type="checkbox" data-role="compare"> Compare two connectors</label>
      <label data-role="secondary-label" hidden for="${prefix}-secondary">Compare with<select id="${prefix}-secondary" data-role="secondary">${options}</select></label>
    </div>
    <div class="explorer__viewer">
      <div class="explorer__stage" data-role="stage"><div class="explorer__diagram" data-role="diagram"></div><div class="explorer__canvas" data-role="canvas" hidden></div><span class="explorer__badge">Illustrative · not to scale</span></div>
      <p class="explorer__status" role="status" data-role="status">Original diagram available offline. Optional 3D loads Three.js from esm.sh only when requested.</p>
      <div class="explorer__actions"><button type="button" data-action="enable">Enable optional 3D</button><button type="button" data-action="diagram" hidden>Use diagram</button><button type="button" data-action="retry" hidden>Retry 3D</button></div>
      <div class="explorer__view-controls" data-role="view-controls" hidden aria-label="3D view controls"><button type="button" data-action="left" aria-label="Rotate view left">← Rotate</button><button type="button" data-action="right" aria-label="Rotate view right">Rotate →</button><button type="button" data-action="up" aria-label="Tilt view up">↑ Tilt</button><button type="button" data-action="down" aria-label="Tilt view down">↓ Tilt</button><button type="button" data-action="in" aria-label="Zoom in">＋ Zoom</button><button type="button" data-action="out" aria-label="Zoom out">− Zoom</button><button type="button" data-action="reset">Reset view</button></div>
      <p class="explorer__hint" data-role="view-hint" hidden>Drag to orbit or use the buttons. Focus the 3D view and use arrow keys to rotate, +/− to zoom, or Home to reset.</p>
    </div>
    <p class="explorer__mode-note" data-role="mode-note"></p>
    <div class="explorer__hotspots" role="group" aria-label="Explain connector features"><button type="button" data-hotspot="contacts" aria-pressed="true">1 · Contacts</button><button type="button" data-hotspot="housing" aria-pressed="false">2 · Housing & grip</button><button type="button" data-hotspot="safety" aria-pressed="false">3 · Safety & signals</button></div>
    <p class="explorer__explanation" data-role="explanation" aria-live="polite"></p>
    <div class="explorer__facts" data-role="facts"></div>
    <section class="explorer__section" aria-labelledby="${prefix}-levels"><h3 id="${prefix}-levels">AC and DC: where conversion happens</h3><div class="explorer__cards"><article><h4>Level 1 · AC</h4><p>In North America, usually a 120 V household supply with suitable charging equipment. Often the slowest option. The onboard charger converts AC to DC.</p></article><article><h4>Level 2 · AC</h4><p>In North America, usually a 208–240 V supply. Common at homes, workplaces and destinations. The vehicle’s onboard charger still limits AC input.</p></article><article><h4>DC fast charging</h4><p>The station converts power to DC before it reaches the vehicle. Often called “Level 3” informally; DC fast charging is the clearer term. Battery conditions and shared site power can limit speed.</p></article></div><p class="explorer__hint">“Level” terminology varies by region. Connector shape does not establish voltage, maximum power, charging time or network access.</p></section>
    <section class="explorer__section" aria-labelledby="${prefix}-energy">
      <h3 id="${prefix}-energy">Follow the energy</h3>
      <label class="explorer__inline-label" for="${prefix}-energy-mode">Energy path<select id="${prefix}-energy-mode" data-role="energy-mode"><option value="ac">AC charging</option><option value="dc">DC fast charging</option></select></label>
      <div class="explorer__flow" data-role="flow"></div>
      <div class="explorer__battery-row">
        <div class="explorer__battery" aria-hidden="true"><div data-role="battery-fill"></div></div>
        <label for="${prefix}-soc">Illustrative battery state of charge: <output data-role="soc-output" for="${prefix}-soc">35%</output><input id="${prefix}-soc" data-role="soc" type="range" min="0" max="100" step="1" value="35"></label>
      </div>
      <div class="explorer__actions"><button type="button" data-action="play">Play battery illustration</button><button type="button" data-action="reset-soc">Reset to 35%</button></div>
      <p class="explorer__hint" data-role="animation-status" role="status">Animation is paused. Its timing has no relation to real charging time.</p>
      <div class="explorer__curve">
        <p class="explorer__hint">Relative power · arbitrary units</p>
        <svg viewBox="0 0 560 170" role="img" aria-labelledby="${prefix}-curve-title ${prefix}-curve-desc">
          <title id="${prefix}-curve-title">Illustrative power taper linked to selected state of charge</title>
          <desc id="${prefix}-curve-desc">An invented relative-power curve, flat until 50 percent then falling toward full. Not measured, predicted or verified for any vehicle.</desc>
          <path d="M48 18V156H535" fill="none" stroke="currentColor" stroke-width="2"/>
          <path data-role="curve-path" fill="none" stroke="currentColor" stroke-width="4"/>
          <line data-role="curve-marker" y1="22" y2="156" stroke="currentColor" stroke-dasharray="4 4"/>
          <circle data-role="curve-dot" r="6" fill="currentColor"/>
        </svg>
        <div class="explorer__curve-axis" aria-hidden="true"><span>0%</span><span>50%</span><span>100% SOC</span></div>
      </div>
      <p class="explorer__warning"><strong>Not a verified vehicle charge curve.</strong> This invented curve only explains the concept of tapering. Actual charging depends on the vehicle, charger, temperature, battery conditioning and other limits. It is not a charging-time or range estimator.</p>
    </section>
    <section class="explorer__section" aria-labelledby="${prefix}-world"><h3 id="${prefix}-world">Other regional interfaces</h3><div class="explorer__cards explorer__cards--two"><article><h4>Type 2 · AC</h4><p>Common in Europe and other markets; supports compatible single- or three-phase AC installations. Not interchangeable with J1772 just because both carry AC.</p><span class="explorer__hint">Learning card only · no 3D model included</span></article><article><h4>CCS Combo 2 · DC</h4><p>Combines a Type 2-style upper interface with two DC power contacts. Common for DC fast charging in Europe and other markets; physically different from CCS1.</p><span class="explorer__hint">Learning card only · no 3D model included</span></article></div></section>
    <footer class="explorer__footer"><p><strong>Originality & sources:</strong> All diagrams, procedural 3D shapes and illustrative animation are original to this app. No manufacturer CAD, logos, station availability or vehicle specifications are used. Optional rendering: Three.js 0.170.0 and OrbitControls (MIT), served by esm.sh.</p><p>Read official background: <a href="https://www.sae.org/standards/content/j3400_202409/" target="_blank" rel="noopener noreferrer">SAE J3400</a> · <a href="https://afdc.energy.gov/fuels/electricity_infrastructure.html" target="_blank" rel="noopener noreferrer">U.S. DOE charging infrastructure</a> · <a href="https://www.charin.global/technology/ccs/" target="_blank" rel="noopener noreferrer">CharIN CCS</a> · <a href="https://www.chademo.com/" target="_blank" rel="noopener noreferrer">CHAdeMO</a>. Always verify vehicle and equipment documentation before connecting or using an adapter.</p></footer>`;
  container.replaceChildren(root);
  const find = (role) => root.querySelector(`[data-role="${role}"]`);
  const button = (action) => root.querySelector(`[data-action="${action}"]`);
  const abort = new AbortController();
  const listen = (element, name, handler, options = {}) =>
    element.addEventListener(name, handler, {
      ...options,
      signal: abort.signal,
    });
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const state = {
    primary: "NACS",
    secondary: "J1772",
    compare: false,
    mode: "connector",
    hotspot: "contacts",
    soc: 35,
    playing: false,
    visible: true,
    disposed: false,
    using3D: false,
    loading: false,
  };
  find("secondary").value = state.secondary;
  let three, renderer, scene, camera, controls, model, resizeObserver, observer;
  let renderFrame = 0;
  let animationFrame = 0;
  let previousTime = 0;

  function isVisible() {
    return state.visible && !document.hidden && !state.disposed;
  }
  function requestRender() {
    if (!renderer || !state.using3D || !isVisible() || renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      if (isVisible() && state.using3D && renderer)
        renderer.render(scene, camera);
    });
  }
  function releaseModel() {
    if (!model) return;
    scene.remove(model);
    model.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material)
        (Array.isArray(object.material)
          ? object.material
          : [object.material]
        ).forEach((material) => material.dispose());
    });
    model = null;
  }
  function mesh(parent, geometry, color, position = [0, 0, 0]) {
    const result = new three.Mesh(
      geometry,
      new three.MeshStandardMaterial({
        color,
        roughness: 0.6,
        metalness: 0.12,
      }),
    );
    result.position.set(...position);
    parent.add(result);
    return result;
  }
  function face(parent, name, x = 0, exploded = false) {
    const item = CONNECTORS[name];
    const group = new three.Group();
    group.position.x = x;
    parent.add(group);
    const z = exploded ? 0.9 : 0;
    const housing = mesh(
      group,
      new three.CylinderGeometry(0.7, 0.65, 0.65, 40),
      item.color,
      [0, 0, exploded ? -0.9 : -0.2],
    );
    housing.rotation.x = Math.PI / 2;
    const plate = mesh(
      group,
      new three.CylinderGeometry(0.61, 0.61, 0.12, 40),
      "#343b37",
      [0, 0, z + 0.16],
    );
    plate.rotation.x = Math.PI / 2;
    if (name === "NACS") {
      housing.scale.x = 0.86;
      plate.scale.x = 0.86;
    } else if (name === "CHAdeMO") {
      housing.scale.set(1.13, 1, 1.13);
      plate.scale.set(1.13, 1, 1.13);
      mesh(
        group,
        new three.BoxGeometry(0.13, 0.68, 0.24),
        item.color,
        [-0.84, 0, -0.1],
      );
      mesh(
        group,
        new three.BoxGeometry(0.13, 0.68, 0.24),
        item.color,
        [0.84, 0, -0.1],
      );
    }
    if (name === "CCS1") {
      mesh(group, new three.BoxGeometry(1.25, 0.7, 0.6), item.color, [
        0,
        -0.72,
        z - 0.1,
      ]);
      mesh(group, new three.BoxGeometry(1.1, 0.58, 0.08), "#343b37", [
        0,
        -0.76,
        z + 0.25,
      ]);
    }
    for (const [px, py, radius] of item.pins) {
      const contact = mesh(
        group,
        new three.CylinderGeometry(radius, radius, 0.14, 20),
        "#dce1dc",
        [px, py, z + 0.3],
      );
      contact.rotation.x = Math.PI / 2;
      const recess = mesh(
        group,
        new three.CylinderGeometry(radius * 0.64, radius * 0.64, 0.015, 20),
        "#202622",
        [px, py, z + 0.38],
      );
      recess.rotation.x = Math.PI / 2;
    }
    mesh(
      group,
      new three.BoxGeometry(0.35, 0.12, 0.45),
      "#616b65",
      [0, 0.73, -0.1],
    );
    const grip = mesh(
      group,
      new three.CylinderGeometry(0.25, 0.19, 1.1, 24),
      "#616b65",
      [0, -0.98, exploded ? -1.8 : -0.4],
    );
    grip.rotation.x = -0.22;
    const cable = mesh(
      group,
      new three.CylinderGeometry(0.11, 0.11, 0.7, 16),
      "#2a302c",
      [0, -1.8, exploded ? -1.8 : -0.5],
    );
    cable.rotation.z = -0.1;
    return group;
  }
  function buildModel() {
    if (!renderer) return;
    releaseModel();
    model = new three.Group();
    scene.add(model);
    if (state.mode === "connector" || state.mode === "exploded") {
      face(
        model,
        state.primary,
        state.compare && state.mode === "connector" ? -1.1 : 0,
        state.mode === "exploded",
      );
      if (state.compare && state.mode === "connector")
        face(model, state.secondary, 1.1);
    } else {
      const car = new three.Group();
      model.add(car);
      car.position.set(state.mode === "scene" ? 0.9 : -0.9, -0.5, 0);
      mesh(car, new three.BoxGeometry(2.2, 0.55, 0.95), "#7b867e");
      mesh(
        car,
        new three.BoxGeometry(1.2, 0.5, 0.85),
        "#b0bab2",
        [0.1, 0.5, 0],
      );
      for (const x of [-0.7, 0.7])
        for (const z of [-0.5, 0.5]) {
          const wheel = mesh(
            car,
            new three.CylinderGeometry(0.29, 0.29, 0.16, 20),
            "#343b37",
            [x, -0.34, z],
          );
          wheel.rotation.x = Math.PI / 2;
        }
      mesh(
        car,
        new three.BoxGeometry(0.24, 0.24, 0.04),
        "#c5cec2",
        [0.8, 0.08, 0.5],
      );
      if (state.mode === "scene") {
        mesh(
          model,
          new three.BoxGeometry(0.8, 1.8, 0.65),
          "#343b37",
          [-1.5, -0.2, 0],
        );
        mesh(
          model,
          new three.BoxGeometry(0.6, 0.45, 0.05),
          "#c5cec2",
          [-1.5, 0.25, 0.35],
        );
        const path = new three.CatmullRomCurve3([
          new three.Vector3(-1.1, 0.3, 0),
          new three.Vector3(-0.7, -0.8, 0.6),
          new three.Vector3(1.7, -0.4, 0.55),
        ]);
        mesh(
          model,
          new three.TubeGeometry(path, 28, 0.045, 8, false),
          "#727c75",
        );
      } else {
        mesh(
          model,
          new three.BoxGeometry(0.42, 0.45, 0.6),
          "#858377",
          [0.7, -0.4, 0.9],
        );
        const connector = face(model, state.primary, 1.7);
        connector.scale.setScalar(0.6);
        connector.position.y = -0.15;
      }
    }
    requestRender();
  }
  function resize() {
    if (!renderer || !state.using3D || !isVisible()) return;
    const bounds = find("stage").getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(bounds.width, bounds.height, false);
    camera.aspect = bounds.width / bounds.height;
    camera.updateProjectionMatrix();
    requestRender();
  }
  function resetView() {
    if (!camera) return;
    camera.position.set(0, 0.6, 6.6);
    controls.target.set(0, -0.45, 0);
    controls.update();
    requestRender();
  }
  function set3D(active) {
    state.using3D = active;
    find("canvas").hidden = !active;
    find("diagram").hidden = active;
    find("view-controls").hidden = !active;
    find("view-hint").hidden = !active;
    button("diagram").hidden = !active;
    button("enable").hidden = active;
    button("enable").textContent = renderer
      ? "Return to 3D"
      : "Enable optional 3D";
    if (controls) controls.enabled = active && isVisible();
    if (active) resize();
    else if (renderFrame) {
      cancelAnimationFrame(renderFrame);
      renderFrame = 0;
    }
  }
  function disposeRenderer() {
    if (renderFrame) cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    if (controls) controls.dispose();
    releaseModel();
    if (renderer) renderer.dispose();
    renderer = null;
    controls = null;
    find("canvas").replaceChildren();
  }
  function loadingFailed() {
    set3D(false);
    disposeRenderer();
    button("enable").textContent = "Enable optional 3D";
    button("retry").hidden = false;
    find("status").textContent =
      "3D is unavailable (network, browser or graphics support). All diagrams, comparisons and learning controls still work. You can retry 3D.";
  }
  async function enable3D() {
    if (state.disposed || state.loading) return;
    if (renderer) {
      set3D(true);
      find("status").textContent =
        "Original procedural 3D illustration. Geometry is schematic, not an engineering model.";
      return;
    }
    state.loading = true;
    button("enable").disabled = true;
    button("retry").hidden = true;
    find("status").textContent =
      "Loading optional Three.js 0.170.0 from esm.sh. The diagram remains usable.";
    try {
      const [threeModule, controlsModule] = await Promise.all([
        import(THREE_URL),
        import(CONTROLS_URL),
      ]);
      if (state.disposed) return;
      three = threeModule;
      renderer = new three.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "low-power",
      });
      renderer.setClearColor(0x000000, 0);
      scene = new three.Scene();
      camera = new three.PerspectiveCamera(40, 1, 0.1, 50);
      scene.add(new three.HemisphereLight(0xffffff, 0x697169, 2.7));
      const light = new three.DirectionalLight(0xffffff, 3);
      light.position.set(3, 4, 6);
      scene.add(light);
      const canvas = renderer.domElement;
      canvas.tabIndex = 0;
      canvas.setAttribute("role", "img");
      canvas.setAttribute(
        "aria-label",
        "Interactive simplified connector illustration. Use the labeled view buttons or arrow keys to rotate; plus and minus zoom; Home resets.",
      );
      find("canvas").append(canvas);
      controls = new controlsModule.OrbitControls(camera, canvas);
      controls.enableDamping = false;
      controls.enablePan = false;
      controls.minDistance = 3;
      controls.maxDistance = 11;
      controls.addEventListener("change", requestRender);
      listen(canvas, "keydown", (event) => {
        const action = {
          ArrowLeft: "left",
          ArrowRight: "right",
          ArrowUp: "up",
          ArrowDown: "down",
          "+": "in",
          "=": "in",
          "-": "out",
          Home: "reset",
        }[event.key];
        if (action) {
          event.preventDefault();
          moveView(action);
        }
      });
      listen(canvas, "webglcontextlost", (event) => {
        event.preventDefault();
        loadingFailed();
      });
      resetView();
      buildModel();
      set3D(true);
      find("status").textContent =
        "Original procedural 3D illustration. Geometry is schematic, not an engineering model.";
    } catch (error) {
      if (!state.disposed) loadingFailed();
    } finally {
      state.loading = false;
      if (!state.disposed) button("enable").disabled = false;
    }
  }
  function moveView(action) {
    if (!camera || !controls) return;
    if (action === "reset") {
      resetView();
      return;
    }
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new three.Spherical().setFromVector3(offset);
    if (action === "left") spherical.theta -= 0.2;
    if (action === "right") spherical.theta += 0.2;
    if (action === "up") spherical.phi -= 0.16;
    if (action === "down") spherical.phi += 0.16;
    if (action === "in") spherical.radius *= 0.85;
    if (action === "out") spherical.radius *= 1.18;
    spherical.phi = Math.max(0.12, Math.min(Math.PI - 0.12, spherical.phi));
    spherical.radius = Math.max(3, Math.min(11, spherical.radius));
    camera.position
      .copy(controls.target)
      .add(offset.setFromSpherical(spherical));
    controls.update();
    requestRender();
  }
  function explain() {
    const describe = (name) => {
      const item = CONNECTORS[name];
      if (state.hotspot === "housing")
        return `${item.short}: The outer housing insulates the contacts and gives the user a grip. The separated-parts mode is conceptual; real assemblies differ and are not user-serviceable.`;
      return `${item.short}: ${item[state.hotspot]}`;
    };
    find("explanation").textContent =
      describe(state.primary) +
      (state.compare && state.mode === "connector"
        ? ` ${describe(state.secondary)}`
        : "");
    root
      .querySelectorAll("[data-hotspot]")
      .forEach((element) =>
        element.setAttribute(
          "aria-pressed",
          String(element.dataset.hotspot === state.hotspot),
        ),
      );
  }
  function updateSelection() {
    state.primary = find("primary").value;
    state.secondary = find("secondary").value;
    state.mode = find("mode").value;
    state.compare = find("compare").checked;
    find("compare").disabled = state.mode !== "connector";
    find("secondary-label").hidden =
      !state.compare || state.mode !== "connector";
    find("diagram").innerHTML = diagramSVG(
      state.primary,
      state.secondary,
      state.compare,
      state.mode,
    );
    const names =
      state.compare && state.mode === "connector"
        ? [state.primary, state.secondary]
        : [state.primary];
    find("facts").innerHTML = names
      .map(
        (name) =>
          `<article><h3>${CONNECTORS[name].title}</h3><p class="explorer__power">${CONNECTORS[name].power}</p><p>${CONNECTORS[name].detail}</p></article>`,
      )
      .join("");
    find("mode-note").textContent = {
      connector:
        "Compare the general forms, then select a labeled feature below. Contact positions and proportions are simplified and must not be used for wiring.",
      exploded:
        "Separated-parts schematic: outer grip, insulating body and contact face are spaced apart to explain their roles. This is not an actual assembly sequence or repair guide. Comparison is available in Connector face mode.",
      port: "Generic inlet → optional adapter → connector. This diagram does not assert any adapter is compatible. Check vehicle approval, AC/DC support, charging-network rules, adapter ratings and manufacturer instructions. Never force a connection.",
      scene:
        "A generic charging introduction: park safely, follow station instructions, connect a compatible cable, authorize if required, then start charging. At the end, stop the session and unlock as directed before unplugging. No live charging session is represented.",
    }[state.mode];
    explain();
    buildModel();
  }
  const relativePower = (soc) =>
    soc <= 50 ? 0.82 : 0.82 - 0.72 * Math.pow((soc - 50) / 50, 0.8);
  function updateBattery() {
    const soc = Math.round(state.soc);
    find("soc").value = String(soc);
    find("soc-output").textContent = `${soc}%`;
    find("battery-fill").style.width = `${state.soc}%`;
    const x = 48 + state.soc * 4.82;
    const y = 151 - relativePower(state.soc) * 127;
    find("curve-marker").setAttribute("x1", x);
    find("curve-marker").setAttribute("x2", x);
    find("curve-dot").setAttribute("cx", x);
    find("curve-dot").setAttribute("cy", y);
  }
  function updateFlow() {
    const stages =
      find("energy-mode").value === "ac"
        ? [
            "Grid AC",
            "AC charging equipment",
            "Onboard AC → DC charger",
            "Battery DC",
          ]
        : [
            "Grid AC",
            "Station AC → DC conversion",
            "Vehicle DC input",
            "Battery DC",
          ];
    find("flow").innerHTML = stages
      .map(
        (text, index) =>
          `<span>${text}</span>${index < stages.length - 1 ? '<b aria-hidden="true">→</b>' : ""}`,
      )
      .join("");
    find("flow").setAttribute("aria-label", stages.join(" to "));
  }
  function updatePlayback() {
    button("play").textContent = state.playing
      ? "Pause battery illustration"
      : state.soc >= 100
        ? "Replay battery illustration"
        : "Play battery illustration";
    button("play").setAttribute("aria-pressed", String(state.playing));
    find("animation-status").textContent = state.playing
      ? isVisible()
        ? "Illustration playing — not real charging time. Pause or move the slider at any time."
        : "Illustration suspended while this panel is out of view."
      : motion.matches
        ? "Reduced motion respected: animation stays off unless you explicitly play it. The slider works without animation."
        : "Animation is paused. Its timing has no relation to real charging time.";
  }
  function stopAnimationFrame() {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    previousTime = 0;
  }
  function tick(time) {
    animationFrame = 0;
    if (!state.playing || !isVisible()) {
      previousTime = 0;
      return;
    }
    if (previousTime)
      state.soc = Math.min(
        100,
        state.soc + (Math.min(time - previousTime, 100) / 1000) * 4,
      );
    previousTime = time;
    updateBattery();
    if (state.soc >= 100) {
      state.playing = false;
      previousTime = 0;
      updatePlayback();
    } else animationFrame = requestAnimationFrame(tick);
  }
  function syncActivity() {
    if (controls) controls.enabled = state.using3D && isVisible();
    if (!isVisible()) {
      stopAnimationFrame();
      if (renderFrame) cancelAnimationFrame(renderFrame);
      renderFrame = 0;
    } else {
      resize();
      if (state.playing && !animationFrame)
        animationFrame = requestAnimationFrame(tick);
    }
    updatePlayback();
  }
  listen(root, "click", (event) => {
    const target = event.target.closest("button");
    if (!target || !root.contains(target)) return;
    if (target.dataset.hotspot) {
      state.hotspot = target.dataset.hotspot;
      explain();
      return;
    }
    const action = target.dataset.action;
    if (action === "enable" || action === "retry") {
      enable3D();
      return;
    }
    if (action === "diagram") {
      set3D(false);
      find("status").textContent =
        "Original static diagram selected. Optional 3D is paused; all learning controls remain available.";
      return;
    }
    if (action === "play") {
      state.playing = !state.playing;
      if (state.playing && state.soc >= 100) {
        state.soc = 0;
        updateBattery();
      }
      stopAnimationFrame();
      syncActivity();
      return;
    }
    if (action === "reset-soc") {
      state.playing = false;
      state.soc = 35;
      stopAnimationFrame();
      updateBattery();
      updatePlayback();
      return;
    }
    moveView(action);
  });
  for (const role of ["primary", "secondary", "mode", "compare"])
    listen(find(role), "change", updateSelection);
  listen(find("energy-mode"), "change", updateFlow);
  listen(find("soc"), "input", () => {
    state.soc = Number(find("soc").value);
    state.playing = false;
    stopAnimationFrame();
    updateBattery();
    updatePlayback();
  });
  listen(document, "visibilitychange", syncActivity);
  listen(window, "resize", resize);
  listen(motion, "change", () => {
    if (motion.matches) {
      state.playing = false;
      stopAnimationFrame();
    }
    updatePlayback();
  });
  if ("ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(find("stage"));
  }
  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver(
      (entries) => {
        state.visible = entries[0].isIntersecting;
        syncActivity();
      },
      { threshold: 0 },
    );
    observer.observe(root);
  }
  find("curve-path").setAttribute(
    "d",
    Array.from(
      { length: 101 },
      (_, soc) =>
        `${soc ? "L" : "M"}${48 + soc * 4.82},${151 - relativePower(soc) * 127}`,
    ).join(" "),
  );
  updateSelection();
  updateFlow();
  updateBattery();
  updatePlayback();
  return () => {
    if (state.disposed) return;
    state.disposed = true;
    state.playing = false;
    abort.abort();
    stopAnimationFrame();
    if (observer) observer.disconnect();
    if (resizeObserver) resizeObserver.disconnect();
    disposeRenderer();
    root.remove();
  };
}
