---
layout: page
title: Themes
---
:warning: ***IMPORTANT!*** It is recommended you don't make any customisations to the included 
`luciano_blocktronics' theme. Create your own and make changes to that instead:

1. Copy `/art/themes/luciano_blocktronics` to `art/themes/your_board_theme`
2. Update the `info` block at the top of the theme.hjson file:
   
        info: {
                name: Awesome Theme
                author: Cool Artist
                group: Sick Group
                enabled: true
        }

3. Specify it in the `defaults` section of `config.hjson`. The name supplied should match the name of the 
directory you created in step 1:

        ```hjson 
        defaults: {
          theme: your_board_theme
        }
        ```
