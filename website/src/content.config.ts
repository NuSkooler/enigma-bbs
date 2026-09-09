import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

//  Content lives at the conventional src/content/docs/. Starlight derives the
//  sidebar from this tree, so a new page cannot be invisible in the nav the way
//  six of them were under the hand-maintained Jekyll list.
export const collections = {
    docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
