ALTER TABLE `public_embed_configs`
ADD COLUMN `output_format` text NOT NULL DEFAULT 'iframe'
CHECK (`output_format` IN ('iframe', 'json'));

ALTER TABLE `public_embed_configs`
ADD COLUMN `theme` text NOT NULL DEFAULT 'light'
CHECK (`theme` IN ('light', 'dark'));

ALTER TABLE `public_embed_configs`
ADD COLUMN `accent_color` text NOT NULL DEFAULT '#3157D5'
CHECK (
  length(`accent_color`) = 7
  AND `accent_color` = upper(`accent_color`)
  AND `accent_color` GLOB '#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'
);

ALTER TABLE `public_embed_configs`
ADD COLUMN `density` text NOT NULL DEFAULT 'comfortable'
CHECK (`density` IN ('comfortable', 'compact'));

ALTER TABLE `public_embed_configs`
ADD COLUMN `show_search` integer NOT NULL DEFAULT 0
CHECK (`show_search` IN (0, 1));

ALTER TABLE `public_embed_configs`
ADD COLUMN `show_filters` integer NOT NULL DEFAULT 0
CHECK (`show_filters` IN (0, 1));

ALTER TABLE `public_embed_configs`
ADD COLUMN `show_event_summary` integer NOT NULL DEFAULT 0
CHECK (`show_event_summary` IN (0, 1));
