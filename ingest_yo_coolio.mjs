import { createClient } from '@supabase/supabase-js';

const GATEWAY_URL = 'https://ai.gateway.lovable.dev/v1';
const EMBED_MODEL = 'openai/text-embedding-3-small';

const title = 'Yo Coolio in Brühl-Beurbarung';
const source = 'InZeitung, Ausgabe 39';
const content = `Eine typische Pub-Quiz-Frage könnte lauten: »Nennen Sie bitte einen Freiburger Stadtteil mit einem Flugplatz und einem Bahnhof.« Die richtige Antwort (für manche wie aus der Pistole geschossen) wäre Brühl-Beurbarung. Dieser Stadtteil mit seinem ganz eigenen Charme (weil er unter anderem das Kino Kandelhof beherbergt) entstand vor rund 130 Jahren im Zuge der Industrialisierung Freiburgs. Schlichte, pragmatische Bauten prägen das Stadtbild, charakteristisch sind kleine Fenster wie Schiffsluken zur Straße hin, und im Innenhof finden sich oft bunte Mini-Schrebergärten, als wolle sich eine Schönheit hinter seinem Schleier verstecken. In der direkten Nachbarschaft ist das neue Stadion des SC Freiburg (heute den 5. Platz in der Bundesliga) und die nicht mehr ganz so neue Neue Messe. Insgesamt hat der Stadtteil noch rund 12.000 Einwohnerinnen und Einwohner, mit der Bebauung des ehemaligen Güterbahnhofsgeländes werden rund 4000 Menschen mehr im Stadtteil leben und diesem eine ordentliche Bevölkerungsdichte verleihen. Der Brühler Kern und das Güterbahnhofsareal unterscheiden sich optisch und auch inhaltlich, ähnlich wie London Eastend und Westend, nur im Kleinen. Alt gegen neu, ursprünglich proletarisches Arbeiterviertel gegen Wohlstandswohnungen. Die Mischung macht's.

Herzstück von Brühl-Beurbarung ist die Lortzing-Schule, eine von 30 öffentlichen Grundschulen in Freiburg. Benannt wurde sie nach Gustav Albert Lortzing, einem Berliner Komponisten, der ungefähr dann starb, als Brühl entstand. Laut ihrem Sozialcurriculum hat die Lortzing-Schule im laufenden Schuljahr 277 Schülerinnen und Schüler, davon rund 52 Prozent mit eigener/elterlicher Einwanderungsgeschichte. Die Sprachenvielfalt umfasst etwa 27 verschiedene Sprachen. Allein in der Klasse meiner Tochter, eine halbe deutsche Kartoffel, wird zuhause Albanisch, Arabisch, Bosnisch, Türkisch, Kurdisch, Mongolisch, Romanes, Russisch, Spanisch, Sri-lankisch und Ukrainisch (neben Deutsch) gesprochen. Das ist vielleicht mehr als in einer Klasse des weltoffenen United World College in Littenweiler. Der Vergleich musste sein, weil die Grundschulen keinen renommierten Internatscharakter haben, dafür aber einen wichtigen Grundstein für den Bildungskanon legen. Die Willkommenskultur der Schule und das gute Miteinander sind im Lortzing-Sozialcurriculum festgeschrieben und werden von jeder neuen Lehrkraft verinnerlicht und an die Kleinen weitergegeben. Früh übt sich's. In diesem Zusammenhang habe ich kürzlich mit einem Schmunzeln das aktuelle Programm des Zentrums für Schlüsselqualifikationen der Universität Freiburg gelesen, ein erstklassiges Angebot, und wissen Sie, was da unter anderem im Lehrplan steht? Gleich drei Seminare mit dem Thema interkulturelle Kompetenz und Vielfalt in einer globalisierten Welt. Was die Erstklässlerinnen und Erstklässler der bunten Lortzing-Schule quasi in die Wiege gelegt bekommen, wird für sie spätestens mit Anfang/Mitte zwanzig beim Eintritt in die Berufswelt enorm relevant.

Und noch eine Anekdote zur transkulturellen Kompetenz: Vor ein paar Monaten kam unsere Kleine ganz aufgeregt von der Schule nach Hause und fragte, ob sie bald in die Hölle käme, weil sie in der Nachmittagsbetreuung einen nackten Mann aus Knetmasse gebastelt hatte (wie ich sie kenne, ist sie bequem und hatte keine Lust, noch Kleider zu basteln). Ihre Klassenkameradin warnte sie davor, in den Tiefen der Erde zu versinken, weil Nacktheit Haram sei. Wir mussten ihr erst erklären, dass verschiedene Kulturen unterschiedliche Schamgefühle haben und wir darauf Rücksicht nehmen müssen. An dieser Stelle möchte ich erwähnen, dass wir zu Hause keineswegs nackt herumlaufen. Auch wenn es draußen heiß ist, wie im Song von Biga Ranx »Solid we're solid, hotter than the high grade«. À propos, Biga Ranx ist ein Franzose, der im jamaikanischen Patois singt und den die Kleine seit ein paar Tagen solide hört. Yo Coolio* – Lortzing ist so!

Anmerkungen

* Yo Coolio

»Hallo, Coolio« – Coolio ist ein US-amerikanischer Rapper. Typischer Gruß in der Lortzing-Schule.`;

function chunkText(content) {
  return content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

async function embed(text) {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error('Missing LOVABLE_API_KEY');
  const res = await fetch(`${GATEWAY_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data[0].embedding;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase credentials');
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const chunks = chunkText(content);
  console.log(`Detected ${chunks.length} chunks`);

  const vectors = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`Embedding chunk ${i + 1}/${chunks.length}...`);
    vectors.push(await embed(chunks[i]));
  }

  const { data: essay, error: essayErr } = await supabase
    .from('essays')
    .insert({ title, content, source })
    .select('id')
    .single();
  if (essayErr || !essay) throw new Error(essayErr?.message ?? 'Insert failed');

  const rows = chunks.map((text, i) => ({
    essay_id: essay.id,
    chunk_index: i,
    content: text,
    embedding: vectors[i],
  }));
  const { error: chunkErr } = await supabase.from('essay_chunks').insert(rows);
  if (chunkErr) {
    await supabase.from('essays').delete().eq('id', essay.id);
    throw new Error(chunkErr.message);
  }

  console.log('Ingested:', { essay_id: essay.id, chunk_count: rows.length });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
