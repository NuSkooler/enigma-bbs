import { defineCollection, z } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';

//  Starlight looks for both collections and warns on every build when the i18n
//  one is missing, even for a single-language site. Declaring it costs nothing
//  and silences the noise; src/content/i18n/ stays empty until there is a
//  translation to put in it.
export const collections = {
    docs: defineCollection({
        loader: docsLoader(),
        //  `description` is required rather than optional. The site shipped for
        //  years with none at all: no meta descriptions, no Open Graph
        //  descriptions, and nothing under the title in search results. Making
        //  it a build failure is the only thing that keeps that from creeping
        //  back one page at a time.
        //
        //  `layout` is rejected outright. It was a Jekyll key carried across on
        //  all 108 pages, and Starlight silently ignores it -- so a page could
        //  declare a layout that did nothing and look correct.
        schema: docsSchema({
            extend: z
                .object({
                    description: z
                        .string()
                        .min(20, 'description is too short to be useful')
                        .max(
                            200,
                            'description is truncated in search results and meta tags above ~160 characters'
                        ),
                })
                .strict(),
        }),
    }),
    i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
