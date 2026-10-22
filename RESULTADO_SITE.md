










Vou responder em português e gerar dois arquivos: uma página completa em HTML/CSS/JS (bento + editorial, com contagem, chat guiado, animações e reatividade) e o script SQL de criação/seed do banco.

## `index.html` — Nbz Construção e Impermeabilização (HTML + CSS embutido + JS)

```html
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nbz Construção e Impermeabilização · Proteção de canteiro a edificação</title>
<meta name="description" content="Corpo técnico, memoriais de cálculo e dupla garantia — impermeabilização executada de canteiro a edificação." />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,900;1,9..144,600&family=Manrope:wght@300;400;500;600;700;800&family=Sora:wght@500;700;800&display=swap" rel="stylesheet">

<style>
/* ============ DESIGN SYSTEM ============ */
:root{
  --paper:#F3EFE6; --paper-2:#EAE3D5;
  --ink:#142329; --ink-2:#3D4E54;
  --sea-900:#0A2A32; --sea-800:#0F3944; --sea-700:#155563;
  --teal:#0E8F8A; --teal-deep:#0A5A59; --aqua:#22C4B0;
  --clay:#D9531E; --clay-deep:#B6400F;
  --sand:#E9DDC6; --line:rgba(20,35,41,.13); --line-dk:rgba(233,221,198,.16);
  --font-display:'Sora', sans-serif;
  --font-serif:'Fraunces', Georgia, serif;
  --font-body:'Manrope', system-ui, sans-serif;
  --wrap:1220px; --pad:clamp(20px,5vw,64px);
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{
  font-family:var(--font-body); color:var(--ink); background:var(--paper);
  line-height:1.6; -webkit-font-smoothing:antialiased; overflow-x:hidden;
}
img{max-width:100%;display:block}
a{color:inherit;text-decoration:none}
button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}
::selection{background:var(--aqua);color:var(--sea-900)}

.wrap{max-width:var(--wrap);margin:0 auto;padding:0 var(--pad)}
section{padding:clamp(64px,9vw,124px) 0;position:relative;scroll-margin-top:88px}
.serif{font-family:var(--font-serif)}

/* grain overlay */
.noise{position:fixed;inset:0;z-index:9998;pointer-events:none;opacity:.05;mix-blend-mode:multiply;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3'/%3E%3C