// Proxy simples para a API publica do PNCP e do IBGE (evita problemas de CORS)
const NOMES = ["Carnaubal","Croatá","Guaraciaba do Norte","Ibiapina","Ipu","Ipueiras","São Benedito","Tianguá","Ubajara","Viçosa do Ceará"];
const H = { "content-type": "application/json", "access-control-allow-origin": "*" };
const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const ok = (b, c = 200) => ({ statusCode: c, headers: H, body: JSON.stringify(b) });

const FALHAS = [];
async function getJson(url) {
  let r;
  try { r = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 licitacoes-ibiapaba" } }); }
  catch (e) { FALHAS.push("rede: " + e.message); return { data: [] }; }
  if (!r.ok) { FALHAS.push("HTTP " + r.status + " em " + url.split("?")[0].split("/").slice(-1)[0]); return { data: [], erro: r.status }; }
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { data: [] }; }
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  try {
    if (q.action === "municipios") {
      const lista = await getJson("https://servicodados.ibge.gov.br/api/v1/localidades/estados/CE/municipios");
      const alvo = NOMES.map(norm);
      const res = (Array.isArray(lista) ? lista : []).filter(m => alvo.includes(norm(m.nome)))
        .map(m => ({ nome: m.nome, ibge: String(m.id) })).sort((a, b) => a.nome.localeCompare(b.nome));
      return ok(res);
    }
    const ibges = (q.ibge || "").split(",").filter(Boolean);
    const mods = (q.modalidades || "4,5,6,7,8,9,12").split(",").filter(Boolean);
    const modo = q.modo === "publicacao" ? "publicacao" : "proposta";
    const maxPag = 30;
    const hoje = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const dF = (q.dataFinal || hoje).replace(/-/g, "");
    const dI = (q.dataInicial || dF).replace(/-/g, "");
    FALHAS.length = 0;
    const jobs = [];
    for (const ibge of ibges) for (const mod of mods) jobs.push({ ibge, mod });

    const rodar = async ({ ibge, mod }) => {
      const out = [];
      for (let p = 1; p <= maxPag; p++) {
        const u = new URL(`https://pncp.gov.br/api/consulta/v1/contratacoes/${modo}`);
        u.searchParams.set("dataFinal", dF);
        if (modo === "publicacao") u.searchParams.set("dataInicial", dI);
        u.searchParams.set("codigoModalidadeContratacao", mod);
        u.searchParams.set("codigoMunicipioIbge", ibge);
        u.searchParams.set("uf", "CE");
        u.searchParams.set("pagina", p);
        u.searchParams.set("tamanhoPagina", 100);
        const j = await getJson(u.toString());
        (j.data || []).forEach(x => out.push(x));
        if (!j.totalPaginas || p >= j.totalPaginas) break;
      }
      return out;
    };
    const res = []; let i = 0;
    await Promise.all(Array.from({ length: 8 }, async () => { while (i < jobs.length) { const j = jobs[i++]; res.push(await rodar(j)); } }));
    const todos = res.flat();
    const vistos = new Set();
    const itens = todos.filter(x => !vistos.has(x.numeroControlePNCP) && vistos.add(x.numeroControlePNCP)).map(x => ({
      id: x.numeroControlePNCP,
      objeto: x.objetoCompra,
      orgao: x.orgaoEntidade?.razaoSocial,
      unidade: x.unidadeOrgao?.nomeUnidade,
      municipio: x.unidadeOrgao?.municipioNome,
      modalidade: x.modalidadeNome,
      situacao: x.situacaoCompraNome,
      valor: x.valorTotalHomologado || x.valorTotalEstimado,
      publicacao: x.dataPublicacaoPncp,
      abertura: x.dataAberturaProposta,
      encerramento: x.dataEncerramentoProposta,
      link: x.orgaoEntidade?.cnpj ? `https://pncp.gov.br/app/editais/${x.orgaoEntidade.cnpj}/${x.anoCompra}/${x.sequencialCompra}` : null,
      origem: x.linkSistemaOrigem
    }));
    return ok({ total: itens.length, itens, falhas: [...new Set(FALHAS)] });
  } catch (e) {
    return ok({ erro: String(e) }, 500);
  }
};
