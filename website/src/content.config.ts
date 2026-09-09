import { defineCollection } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';

//  Starlight looks for both collections and warns on every build when the i18n
//  one is missing, even for a single-language site. Declaring it costs nothing
//  and silences the noise; src/content/i18n/ stays empty until there is a
//  translation to put in it.
export const collections = {
    docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
    i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
