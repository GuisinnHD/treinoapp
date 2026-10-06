// Função serverless da Vercel: guarda os dados no Upstash Redis (Marketplace da Vercel).
// API genérica: o corpo diz o "tipo" do registro. Para juntar outros apps (água, creatina)
// depois, basta acrescentar uma linha na tabela TIPOS abaixo.
const crypto = require("crypto");

// APP_SENHA aceita vários códigos separados por vírgula: um por pessoa.
// O 1º código usa as chaves "treino:*"; cada um dos outros tem a sua própria área (prefixo com hash).
const CODIGOS = (process.env.APP_SENHA || "").split(",").map((s) => s.trim()).filter(Boolean);
function prefixoDe(codigo) {
  const i = CODIGOS.indexOf(codigo);
  if (i < 0) return null;
  return i === 0 ? "treino" : "treino:" + crypto.createHash("sha256").update(codigo).digest("hex").slice(0, 16);
}

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

// HGETALL volta como lista [campo, valor, campo, valor...] (ou já como objeto)
function pares(res) {
  const out = {};
  const ler = (s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } };
  if (Array.isArray(res)) for (let i = 0; i < res.length; i += 2) out[res[i]] = ler(res[i + 1]);
  else if (res && typeof res === "object") for (const k of Object.keys(res)) out[k] = ler(res[k]);
  return out;
}

// ---------- Validação (tudo é conferido aqui, nunca confiamos no app) ----------
const ID = /^[a-z0-9_-]{1,40}$/;
const ehObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const texto = (s, max, min) => typeof s === "string" && s.trim().length >= min && s.length <= max;
function dataValida(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [a, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  return a >= 2000 && a <= 2100 && dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function vTreino(v) {
  if (!ehObj(v)) return { erro: "Treino inválido" };
  if (!dataValida(v.d)) return { erro: "Data inválida" };
  const r = v.r === undefined ? "" : v.r;
  if (!texto(r, 60, 0)) return { erro: "Nome da rotina inválido (máx. 60 letras)" };
  if (!Array.isArray(v.ex) || v.ex.length > 30) return { erro: "Lista de exercícios inválida (máx. 30)" };
  const ex = [];
  for (const e of v.ex) {
    if (!ehObj(e) || !texto(e.n, 60, 1)) return { erro: "Nome de exercício inválido (1 a 60 letras)" };
    if (!Array.isArray(e.s) || e.s.length > 40) return { erro: "Lista de séries inválida (máx. 40)" };
    const s = [];
    for (const x of e.s) {
      if (!ehObj(x) || typeof x.k !== "number" || !isFinite(x.k) || x.k < 0 || x.k > 2000) return { erro: "Carga inválida (0 a 2000 kg)" };
      if (!Number.isInteger(x.r) || x.r < 0 || x.r > 1000) return { erro: "Repetições inválidas (0 a 1000)" };
      s.push({ k: Math.round(x.k * 100) / 100, r: x.r });
    }
    ex.push({ n: e.n.trim(), s });
  }
  return { valor: { d: v.d, r: r.trim(), f: v.f === true, x: v.x === true, ex } };
}

function vRotina(v) {
  if (!ehObj(v)) return { erro: "Rotina inválida" };
  const x = v.x === true;
  if (!texto(v.n, 60, x ? 0 : 1)) return { erro: "Nome da rotina inválido (1 a 60 letras)" };
  if (!Array.isArray(v.ex) || v.ex.length > 40 || !v.ex.every((n) => texto(n, 60, 1))) return { erro: "Exercícios da rotina inválidos (máx. 40, nome de 1 a 60 letras)" };
  return { valor: { n: v.n.trim(), ex: v.ex.map((n) => n.trim()), x } };
}

function vCfg(v) {
  if (!ehObj(v) || !Number.isInteger(v.desc) || v.desc < 0 || v.desc > 600) return { erro: "Descanso inválido (0 a 600 segundos)" };
  return { valor: { desc: v.desc } };
}

// tipo -> { col: hash no Redis, val: validador }
const TIPOS = {
  treino: { col: "treinos", val: vTreino },
  rotina: { col: "rotinas", val: vRotina },
  cfg: { col: "cfg", val: vCfg }
};

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!CODIGOS.length || !URL_ || !TOKEN) return res.status(500).json({ erro: "Servidor sem configuração (APP_SENHA ou banco)" });
  const p = prefixoDe(String(req.headers["x-senha"] || ""));
  if (!p) return res.status(401).json({ erro: "Código incorreto" });

  try {
    if (req.method === "GET") {
      const nomes = Object.keys(TIPOS);
      const listas = await Promise.all(nomes.map((t) => redis(["HGETALL", `${p}:${TIPOS[t].col}`])));
      const out = {};
      nomes.forEach((t, i) => { out[TIPOS[t].col] = pares(listas[i]); });
      return res.status(200).json(out);
    }

    if (req.method === "POST") {
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
      if (!ehObj(b)) return res.status(400).json({ erro: "Corpo da requisição inválido" });
      if (JSON.stringify(b).length > 30000) return res.status(400).json({ erro: "Dados grandes demais" });
      const tipo = TIPOS[b.tipo];
      if (!tipo || !Object.prototype.hasOwnProperty.call(TIPOS, b.tipo)) return res.status(400).json({ erro: "Tipo desconhecido" });
      if (typeof b.id !== "string" || !ID.test(b.id)) return res.status(400).json({ erro: "Identificador inválido" });
      const r = tipo.val(b.valor);
      if (r.erro) return res.status(400).json({ erro: r.erro });
      let t = ehObj(b.valor) && b.valor.t !== undefined ? Number(b.valor.t) : Date.now();
      if (!Number.isFinite(t) || t <= 0) t = Date.now();
      if (t > Date.now() + 864e5) return res.status(400).json({ erro: "Horário inválido" });
      await redis(["HSET", `${p}:${tipo.col}`, b.id, JSON.stringify({ ...r.valor, t: Math.round(t) })]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erro: "Método não permitido" });
  } catch (e) {
    return res.status(500).json({ erro: "Falha no banco de dados" });
  }
};
