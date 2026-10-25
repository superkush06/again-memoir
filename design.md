# Again — Visual Direction

## Core idea

Again should feel like someone turned a folder of ordinary, personal photos into a thoughtful moving photo dump. The photographs are the design. Interface chrome, branding, paper textures, handwriting, and color accents support them without replacing them.

The visual reference is a sequence that moves between:

1. a few white-bordered photos placed on lightly ruled or crumpled paper;
2. a compact, irregular mosaic of candid photographs;
3. one photograph filling most or all of the screen;
4. a soft blur, pan, zoom, or paper transition into the next arrangement.

The result should feel candid, warm, slightly imperfect, and made from the user's real life—not like a travel campaign, an AI poster, or a themed social-media dashboard.

### Chosen balance: paper first

The default scrapbook view uses the paper-first direction selected by the product owner:

- roughly 55% photographs and 45% lightly ruled or crumpled warm-white paper;
- white-bordered prints with intentional 0–3 degree rotations;
- one larger hero photograph supported by smaller surrounding photographs;
- a short contextual title written directly on the paper;
- restrained overlap and shadow, without sticker clutter.

The edge-to-edge mosaic remains a secondary layout for denser albums, mid-sequence transitions, and moments when the photographs benefit from filling the screen. It is not the default library presentation.

## Non-negotiable photo rule

Uploaded photographs are the source of truth.

- Never generate, replace, beautify, repaint, or invent people, faces, places, clothing, or objects for the scrapbook UI.
- Never use synthetic lifestyle photography as a substitute for the user's media.
- Preserve the original file and always provide a way to view it without treatment.
- The collage system may crop, scale, position, mask, frame, and gently grade a display copy. It must not change what happened in the photograph.
- AI may help choose an arrangement or transition, but its output is layout metadata—not replacement imagery.

This rule applies to the web library and scrapbook presentation. The separate 3D reconstruction is explicitly labeled as an inference and keeps the original photograph available.

## Visual character

### Photography

- Favor candid, imperfect, flash-lit, phone-camera moments over polished hero imagery.
- Let photographs occupy at least 80–90% of a scrapbook or recap view.
- Mix close crops, full-frame photographs, and small white-bordered prints.
- Use irregular but intentional layouts. A collage should feel composed, not randomized.
- Allow occasional softness, motion blur, faded blacks, warm highlights, and subtle grain.
- Keep faces recognizable and skin color believable. Film treatment must stay mild.

### Paper and framing

- Use warm white or light gray paper, faint notebook rules, and restrained crumpled-paper texture.
- White photo borders may vary slightly in width, as with printed snapshots.
- Rotation should normally stay within 0–3 degrees.
- Overlap photographs only when it improves rhythm or creates a transition.
- Tape, torn edges, doodles, stamps, and stickers are exceptional accents—not a default layer on every photograph.

### Contextual recap titles

- “School recap” is an example from one reference, never a fixed product title.
- Use the album's user-edited title first. Otherwise derive a short title from verified folder, date, place, source caption, or event metadata.
- Titles should change with the memory: for example “october lately,” “weekend at home,” or a known event name.
- Never invent a school, trip, relationship, celebration, or location that is not present in the memory data.
- Let the person edit or remove the suggested title before sharing.

### Color

The photographs provide most of the color.

- Ink: `#17151C`
- Paper: `#F5F3EF`
- Clean surface: `#FFFFFF`
- Soft black: `#252329`
- Pink accent: `#FF5E9C`
- Orange accent: `#FF874D`
- Blue accent: `#62C9ED`

Pink, orange, and blue are functional accents and should normally occupy less than 5% of a screen. Do not wash the interface in pink. Use blue for shared/immersive state, orange for a small highlight, and pink for one primary action when needed.

Avoid corporate beige-and-olive palettes, purple AI gradients, glossy travel-ad color grading, and decorative colors that compete with the photographs.

## Typography

- Interface and body copy: `DM Sans`, with regular or medium weights and comfortable sizes.
- Recap titles: a loose black marker/handwriting face used only for a short contextual title. Prefer a real user handwriting asset when available; otherwise use a restrained handwritten font that does not imitate children's stationery.
- Supporting editorial copy may use the existing serif sparingly, but scrapbook screens should not feel like a luxury magazine.
- Do not use handwriting for controls, descriptions, dates, accessibility labels, or long passages.

## Spacing and layout

Use a 4px base scale: `4, 8, 12, 16, 24, 32, 48, 64`.

- Keep persistent app navigation quiet and compact.
- Give the collage canvas nearly the full available viewport.
- Preserve an obvious visual center; do not fill every gap.
- Desktop mosaics generally use 2–4 columns with deliberate size variation.
- Mobile views become a vertical sequence or a two-column photo dump rather than shrinking a desktop collage.
- Essential UI text should be at least 12px; primary controls should meet a 44px touch target.

## Component patterns

### Photo frame

- Displays the real uploaded asset.
- Optional white print border and a very small shadow.
- Optional mild film preset applied only to the presentation copy.
- No caption box beneath every photograph.
- Metadata appears on demand or in one quiet shared caption area.

### Collage board

- Composes several Photo Frames from one memory folder or album.
- Defaults to the paper-first balance: one hero print, supporting prints, and visible quiet paper around them.
- Uses deterministic layouts so reopening the same album feels stable.
- May transition into a denser mosaic or full-frame photograph after the paper-first opening.
- Never adds decorative imagery that was not supplied by the user.

### Memory sequence

- Moves between overview mosaic, individual photograph, and a new arrangement.
- Uses gentle zoom, pan, focus blur, or paper movement.
- Keeps transitions approximately 350–800ms, with longer holds on photographs.
- Provides pause, back, and reduced-motion behavior.

### Step inside

- A small, calm control near the active photograph—not a large marketing button.
- Expands the exact selected photograph while reconstruction loads.
- Crossfades from the photograph into the rendered world only when the first world frame is ready.
- Uses honest copy such as “Building the space around this photo,” without fake percentages.

### Shared memory

- Blue is the primary shared-state accent.
- Participant presence is compact and secondary to the photographs.
- Room controls explain what is truly synchronized: selected memory, scene, album navigation, and participant position.
- Do not imply that pointers, moved objects, voice, or recollections are shared until those features exist.

## Oculus and immersive space

The immersive experience carries the same paper-first identity into 3D, but the paper becomes atmospheric rather than a solid page.

### Translucent paper environment

- Use the same lightly ruled or crumpled warm-white paper texture behind and between memories.
- Render it as thin, softly translucent spatial layers so it does not read as an opaque wall or dominate the reconstructed scene.
- Target a subtle visual opacity around 20–35%, adjusted against the brightness of the active photograph and headset display.
- Let some paper layers dissolve at their edges and recede into depth. Avoid a closed paper box around the viewer.
- Preserve dark or transparent openings between layers so the space feels dimensional and breathable.
- Paper texture must never obscure faces, important photo content, movement controls, or other participants.

### Making memories feel magical

- Treat each real photograph as a luminous memory window, not a flat menu card.
- Build wonder from the photograph's existing depth, gentle parallax, soft edge light, spatial scale, and the transition into its reconstructed world.
- The selected hero photograph may slowly separate into foreground, subject, and background depth layers before the full world appears.
- Use restrained floating light or dust only near the active memory, with color sampled from that photograph.
- Pink, orange, and blue may appear as faint rim light or interaction feedback; never flood the whole world with a branded color.
- Nearby memories can sit as softly lit prints suspended on translucent paper planes, becoming clearer as the viewer approaches or points at them.
- Keep the original photograph visible and recognizable throughout the transition.

Magic must come from presentation, depth, light, and motion—not generated people, invented scenery presented as fact, neon holograms, or fantasy decoration.

### VR comfort and legibility

- Keep primary photo planes world-locked and stable; do not make them constantly bob, spin, or follow the viewer's head.
- Use slow, bounded motion and provide an immediate reduced-motion path.
- Keep interactive memories within comfortable viewing and pointing distance, generally about 1.2–4 metres.
- Maintain strong text contrast and large controls; handwriting remains a title treatment, never an instruction style.
- Avoid dense particle fields, rapid blur, aggressive camera movement, flashing light, and large translucent layers crossing through the viewer.
- In multiplayer, participant silhouettes and navigation remain clearer than the paper atmosphere.

### Web-to-VR transition

1. The chosen printed photograph lifts away from the paper-first web collage.
2. Its surrounding paper becomes translucent while the photograph expands to a comfortable world-locked plane.
3. Subtle depth and parallax appear using the existing reconstruction.
4. The photograph opens into the full memory world only when its first rendered frame is ready.
5. Supporting memories remain behind as quieter suspended prints, preserving the feeling of an album around the active scene.

## Motion

- Motion should feel like editing a personal recap video, not animating a marketing site.
- Favor camera-like movement: crop changes, small push-ins, rack-focus blur, photo slides, and mosaic reassembly.
- Avoid bouncy UI animation, floating stickers, confetti, parallax decoration, and constant idle movement.
- Respect `prefers-reduced-motion`; replace spatial movement with short crossfades.

## Avoid

- AI-generated people or places in the product UI.
- Beach-vacation or lifestyle-campaign imagery used as generic memory content.
- Pink-dominant screens.
- Oversized slogans competing with photographs.
- A uniform card grid with titles and badges under every image.
- Hearts, palm trees, postage stamps, rainbow doodles, and decorative slogans by default.
- Heavy paper texture behind long text.
- Random collage layouts that change on every render.
- Filters that materially alter skin tone or erase the character of the original photograph.
- Technical reconstruction controls presented as the main emotional experience.

## Acceptance test

A successful Again scrapbook should pass these questions:

1. Would the screen still feel personal if all branding disappeared?
2. Are the user's real photographs doing most of the visual work?
3. Can someone immediately find the original, unmodified photograph?
4. Does the treatment resemble a well-edited personal recap rather than generated advertising?
5. Are the collage and transition usable on both a phone and a headset-linked web session?
6. Is every shared or reconstructed behavior described truthfully?
