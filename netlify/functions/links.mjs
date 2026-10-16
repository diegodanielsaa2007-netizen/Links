import { getStore } from "@netlify/blobs";

export const config = { path: ["/api/links", "/l/*"] };

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

export default async (req) => {
  const url = new URL(req.url);
  const store = getStore("links");
  if (url.pathname.startsWith("/l/")) return serve(url, store);
  return admin(req, url, store);
};

// Página pública: previsualización + redirección
async function serve(url, store) {
  const rest = decodeURIComponent(url.pathname.slice(3)).replace(/\/+$/, "");

  if (rest.startsWith("img/")) {
    const r = await store.getWithMetadata(rest, { type: "arrayBuffer" });
    if (!r) return new Response("No encontrado", { status: 404 });
    return new Response(r.data, {
      headers: { "content-type": r.metadata?.type || "image/jpeg", "cache-control": "public, max-age=3600" },
    });
  }

  const l = await store.get(rest, { type: "json" });
  if (!l) return new Response("Link no encontrado", { status: 404 });

  const img = l.hasImg ? `${url.origin}/l/img/${l.code}` : l.image;
  const dest = JSON.stringify(l.dest).replace(/</g, "\\u003c");
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(l.title)}</title>
<meta name="description" content="${esc(l.desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(l.title)}">
<meta property="og:description" content="${esc(l.desc)}">
<meta property="og:url" content="${esc(url.origin + "/l/" + l.code)}">
${img ? `<meta property="og:image" content="${esc(img)}">\n<meta name="twitter:image" content="${esc(img)}">` : ""}
<meta name="twitter:card" content="${img ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${esc(l.title)}">
<meta name="twitter:description" content="${esc(l.desc)}">
<meta http-equiv="refresh" content="0; url=${esc(l.dest)}">
</head>
<body>
<p>Redirigiendo… <a href="${esc(l.dest)}">Haz clic aquí</a>.</p>
<script>location.replace(${dest});</script>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
  });
}

// API del panel (protegida con contraseña)
async function admin(req, url, store) {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) return json({ error: "Falta la variable ADMIN_PASSWORD en Netlify" }, 500);
  if (req.headers.get("x-admin-password") !== pass) return json({ error: "Contraseña incorrecta" }, 401);

  if (req.method === "GET") {
    const { blobs } = await store.list();
    const out = [];
    for (const b of blobs) {
      if (b.key.startsWith("img/")) continue;
      const v = await store.get(b.key, { type: "json" });
      if (v) out.push(v);
    }
    out.sort((a, b) => b.created - a.created);
    return json(out);
  }

  if (req.method === "POST") {
    const d = await req.json();
    const title = String(d.title || "").trim();
    const dest = String(d.dest || "").trim();
    if (!title || !/^https?:\/\//i.test(dest)) return json({ error: "Falta el título o el destino (debe empezar con http)" }, 400);

    let code = String(d.code || "").toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
    if (!code) code = Math.random().toString(36).slice(2, 8);
    if (await store.get(code)) return json({ error: "Ese código ya existe" }, 409);

    let hasImg = false;
    const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(d.imageData || "");
    if (m) {
      const buf = Buffer.from(m[2], "base64");
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      await store.set("img/" + code, ab, { metadata: { type: m[1] } });
      hasImg = true;
    }
    const link = {
      code, title, desc: String(d.desc || "").trim(), dest,
      image: hasImg ? "" : String(d.image || "").trim(), hasImg, created: Date.now(),
    };
    await store.setJSON(code, link);
    return json(link, 201);
  }

  if (req.method === "DELETE") {
    const code = url.searchParams.get("code") || "";
    if (!code) return json({ error: "Falta el código" }, 400);
    await store.delete(code);
    await store.delete("img/" + code);
    return json({ ok: true });
  }

  return json({ error: "Método no permitido" }, 405);
}
