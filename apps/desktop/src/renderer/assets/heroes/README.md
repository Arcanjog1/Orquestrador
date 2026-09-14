# Assets da guilda

Geração: ImageGen integrado. Sem API/CLI adicional.

| Arquivo | Identidade | Situação |
| --- | --- | --- |
| orchestrator-white-mage.png | Arquimago | RGBA |
| programmer-arcane-smith.png | Ferreiro Arcano | Provisório: fundo quadriculado incorporado (RGB) |
| analyst-scholar.png | Erudito | RGBA |
| designer-bard.png | Bardo Artista | RGBA |
| tester-guardian.png | Cavaleiro Guardião | RGBA |
| researcher-explorer.png | Explorador Alquimista | RGBA |
| image-generator-illusionist.png | Ilusionista | RGBA |

Prompt mestre: personagem original em pixel art simples; grade visual de 48×48 ampliada por vizinho mais próximo, pixels grandes, contorno marrom, até 16 cores planas, proporção compacta de NPC de RPG clássico, corpo inteiro em 3/4, luz quente superior esquerda, broche azul/dourado, sem cenário, texto, moldura ou logo, fundo transparente. Mago branco com barba, capuz branco, bordas douradas e cajado com cristal azul.

Variações (o mago simples foi fornecido como referência de estilo): ferreiro de avental e camisa azul com martelo; erudito de óculos/capa azul/livro aberto; bardo ruiva de boina turquesa/túnica vinho/paleta/pincel; guardião de armadura prata/escudo azul/runa verde; explorador de capa musgo/mochila/mapa/poção verde; ilusionista de chapéu e robes violeta/cabelo lavanda/imagem mágica.

Uso: caminho local estável por função. Avatar e sprite compartilham o PNG; estados são aplicados por CSS e não mudam a arte. Substituir o arquivo de mesmo nome troca todas as aparições. Os originais detalhados e a tentativa malsucedida de alpha do ferreiro não são distribuídos.

## Refinamento da taverna

`programmer-arcane-smith-v2.png` é a versão atualmente consumida por `hero-identity.ts`.
Gerada com ImageGen integrado, preservando o ferreiro, a roupa azul, o avental e o martelo.
O arquivo antigo foi preservado. A primeira tentativa de remoção do fundo retornou RGB,
sem alpha; a versão final usa pergaminho opaco, integrado por CSS, sem quadriculado.

Prompt final:
> Use case: precise-object-edit. Edit the provided pixel-art blacksmith sprite for a parchment-colored RPG UI card. Replace ALL white and gray checkerboard background squares with ONE completely uniform, flat warm parchment background, exact color #efd3a1. No checkerboard anywhere, no texture, no shadow, no gradient, no transparency simulation. Keep the full-body brown-haired bearded blacksmith holding a hammer, blue shirt, brown apron, gold-blue pin and simple chunky pixel-art style exactly the same. The only requested change is the background: an entirely flat solid warm beige (#efd3a1), including gaps between the legs and between hammer and body. Centered square framing, no text.
