# Modão

Gerenciador de mods para GTA, feito em cima do **Mod Loader** — o jeito que a
comunidade já instala mod, só que com perfis, conflito resolvido na cara, e
nada apagado sem backup.

San Andreas, III, Vice City e a Definitive Edition, num app só. Windows.

> **Feito com vibe coding.** Este projeto foi escrito quase inteiro por um
> modelo de IA (Claude), dirigido por um humano que testou cada build num
> install real de 48 mods. O que quebrou, quebrou de verdade — e está corrigido
> e coberto por teste. Leia [Problemas conhecidos](#problemas-conhecidos) antes
> de confiar nele com a sua pasta do jogo.

---

## Por que existe

O Mod Loader do Junior_Djjr já resolveu o problema difícil: instalar mod sem
mexer nos arquivos originais do jogo. O que falta em volta dele é o resto:

- **Perfil.** "Meu GTA bonito pra gravar vídeo" e "meu GTA limpo pra jogar
  online" são duas pastas de mods diferentes. Trocar entre elas não devia ser
  renomear pasta na mão.
- **Save separado.** Trocar de perfil sem levar o save junto é como perder o
  progresso.
- **Conflito.** Dois mods mexem no mesmo `.txd`. Qual ganhou? O Mod Loader
  sabe; o usuário não. Aqui dá pra ver, e mudar a prioridade vendo o resultado.
- **Achar mod.** O MixMods tem milhares de posts. O app indexa e deixa buscável,
  offline, com link pro post do autor.
- **Crash.** O GTA fecha sozinho. O Windows registra o endereço da falha. Dá pra
  cruzar isso com o CrashList da comunidade e dizer o que provavelmente foi.

## O que ele faz

| | |
| --- | --- |
| **Perfis** | Conjuntos de mods que dá pra trocar. O conteúdo é guardado uma vez e ligado na pasta do jogo por junction/hardlink — trocar de perfil não copia gigabyte nenhum. |
| **Saves por perfil** | Cada perfil tem os próprios saves, com snapshot. Os saves que já existiam na sua máquina são importados, nunca sobrescritos. |
| **Instalação automática** | Baixa, verifica, extrai, classifica, mostra o plano arquivo por arquivo e só então aplica. Lê o `Leiame.txt` em Windows-1252 e entende "extraia para a pasta do modloader". |
| **Conflitos** | Parser de verdade de `.txd`, `.ifp`, `.img` e PE. Mostra quem ganha cada arquivo duplicado e deixa mudar a prioridade (1–100, 0 = ignorado). |
| **Catálogo** | Índice do MixMods, com o post do autor renderizado como ele escreveu: texto, imagens e vídeo do YouTube. |
| **Diagnóstico** | Lê o Visualizador de Eventos, agrupa os registros de um mesmo crash, e só consulta o CrashList quando a falha é dentro do `gta_sa.exe`. |
| **Nada é apagado** | Arquivo que sai da pasta do jogo vai pra quarentena com hash conferido. Toda troca de perfil é transação, com backup verificado antes de qualquer remoção, e botão de desfazer. |

## Instalação

Baixe o instalador em [Releases](https://github.com/thurdev/modao/releases) e
execute. Windows 10/11, 64-bit.

O app **não** mexe no `gta_sa.exe`, não instala nada dentro do jogo além dos
mods que você mandou instalar, e não precisa de admin — a não ser que seu jogo
esteja em `C:\Program Files`, caso em que ele avisa e oferece reiniciar
elevado.

Se você já usa Mod Loader: o app **adota** o que já está lá. Nada é renomeado,
movido ou reescrito na adoção, e as prioridades que você já tinha no
`modloader.ini` são lidas, não substituídas.

## Como usar

1. **Adicione o jogo.** Ele procura nos lugares comuns (Steam, Rockstar
   Launcher, `C:\Games`) ou você aponta a pasta.
2. **Crie um perfil** — ou deixe ele adotar o que já está instalado.
3. **Explore o catálogo**, instale, e veja o plano antes de aplicar.
4. **Resolva conflitos** na tela de Conflitos, mudando prioridade.
5. **Jogue.** Se crashar, a tela de Saúde lê o Event Log e tenta dizer o porquê.

Antes de trocar de perfil, o botão **Simular** mostra arquivo por arquivo o que
a troca faria, sem tocar em nada.

## O índice

O diretório [`index/`](index/) tem o catálogo em JSON, um arquivo por jogo, pra
quem quiser usar em outra ferramenta:

```
index/sa.json     GTA: San Andreas
index/vc.json     Vice City
index/iii.json    GTA III
index/sade.json   Definitive Edition
index/index.json  manifesto com as contagens
```

Cada entrada tem título, autor, jogo, categoria, versão, **link do post
original**, host do download e um resumo curto.

**O que o índice não tem, de propósito:** o texto completo do post do autor, as
imagens hospedadas, e qualquer arquivo de mod. Isso é trabalho de outra pessoa e
continua no [mixmods.com.br](https://www.mixmods.com.br/), com o nome, as
imagens e a visita do autor. O app busca o post inteiro sob demanda quando você
abre um mod, e guarda em cache só pra você.

Mod de acesso antecipado (Patreon) aparece com o link do autor e **nunca** é
baixado pelo app.

Pra gerar o índice a partir do seu próprio banco:

```bash
npm run index:export -- --db "%APPDATA%\Modao\modao.db" --out index
```

## Problemas conhecidos

- **Definitive Edition é parcial.** O SA:DE é Unreal Engine: não tem Mod Loader,
  não tem prioridade, não tem CLEO. O app detecta a instalação e instala `.pak`
  em `~mods`, e só isso.
- **Alguns hosts não baixam sozinhos.** `sharemods`, MediaFire, Google Drive e
  release do GitHub o app baixa automático. `linkshrink`/`j.gs` (encurtador com
  anúncio — um está morto, o outro caiu num checkpoint humano), `gtainside` e
  Mega caem no diálogo manual: o app abre o link, você baixa, e devolve o
  arquivo pro mesmo plano de instalação.
- **Diagnóstico de crash é só San Andreas.** O CrashList indexa endereço do
  `gta_sa.exe`. Pra III e VC o app mostra o módulo e o offset, mas não chuta
  causa.
- **Só Windows.** macOS e Linux não são alvo.
- **Sem assinatura de código.** O SmartScreen vai reclamar do instalador. O
  código está todo aqui pra você conferir.

## Desenvolvimento

```bash
npm install
npm run dev        # Electron com recarga
npm run ui         # só o renderer, com uma ponte IPC falsa (bom pra mexer em UI)
npm test           # unitários + end-to-end
npm run dist       # instalador NSIS + verificação do asar
```

Stack: Electron 33, React 18, TypeScript, Vite, SQLite (better-sqlite3),
`motion` pra animação. Tudo que é disco e rede vive no processo principal,
atrás de uma superfície de IPC tipada e fechada; o renderer roda em sandbox,
sem Node.

Os testes rodam contra uma instalação sintética de GTA numa pasta temporária —
nenhum deles encosta no seu jogo. O `npm test` cobre, entre outras coisas, o
bug que apagou a pasta `cleo/` de um usuário: hoje toda troca de perfil faz
backup verificado por hash antes de remover qualquer arquivo, e se recusa a
rodar se algum mod não puder ser materializado.

## Créditos

- **[Mod Loader](https://www.mixmods.com.br/2015/01/mod-loader/)** e
  **[CrashInfo](https://www.mixmods.com.br/2022/09/crashinfo/)** — Junior_Djjr.
  Sem eles nada disso existe.
- **[MixMods](https://www.mixmods.com.br/)** — a comunidade de onde vem o
  catálogo. Todo mod aparece com o autor e o link pro post.
- GTA, San Andreas, Vice City e os nomes relacionados são marcas da Rockstar
  Games. Este projeto não é afiliado à Rockstar, não distribui conteúdo do jogo
  e não mexe no executável.

## Licença

[MIT](LICENSE).

---

<details>
<summary><b>English</b></summary>

## Modão

A mod manager for the GTA games, built around **Mod Loader**: profiles,
conflict resolution you can actually see, and nothing deleted without a
verified backup. San Andreas, III, Vice City and the Definitive Edition.
Windows only.

The interface is Brazilian Portuguese by default and English is available in
Settings — pt-BR is the source language here, not the translation.

**Vibe-coded:** this was written almost entirely by an AI model (Claude),
driven by a human who tested every build against a real 48-mod install. What
broke, broke for real, and is now fixed and covered by tests.

### What it does

Profiles whose payloads are stored once and linked into the game folder
(switching never copies gigabytes), per-profile save games with snapshots,
an install pipeline that shows you the file-level plan before it applies it,
real binary parsers for `.txd`/`.ifp`/`.img`/PE to tell you which mod wins a
duplicated file, a searchable offline index of MixMods, and crash analysis that
reads the Windows Event Log — computing `0x400000 + offset` only when the fault
is actually inside `gta_sa.exe`.

Nothing is ever deleted: files leaving the game folder go to quarantine, and
every profile switch is a transaction with a hash-verified backup taken before
anything is removed, plus a dry run and an undo.

### The index

[`index/`](index/) holds the catalogue as JSON, one file per game: title,
author, game, category, version, **a link to the original post**, download host
and a short excerpt. It deliberately does not include the authors' full post
text, their images, or any mod file — that work stays on
[mixmods.com.br](https://www.mixmods.com.br/). Paywalled early-access builds
are never downloaded by the app.

### Known issues

Definitive Edition support is partial (no Mod Loader, no priorities, `.pak`
only); `linkshrink`/`j.gs`/`gtainside`/Mega fall back to a manual download
dialog; crash diagnosis is San Andreas only; Windows only; the installer is
unsigned.

### Credits

[Mod Loader](https://www.mixmods.com.br/2015/01/mod-loader/) and
[CrashInfo](https://www.mixmods.com.br/2022/09/crashinfo/) by Junior_Djjr, and
the [MixMods](https://www.mixmods.com.br/) community. Not affiliated with
Rockstar Games; distributes no game content and never patches the executable.

MIT licensed.

</details>
