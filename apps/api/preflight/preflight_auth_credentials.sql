SELECT
  lower(trim(`email`)) AS `normalized_email`,
  COUNT(*) AS `collision_count`,
  group_concat(`id`) AS `user_ids`
FROM `users`
GROUP BY lower(trim(`email`))
HAVING COUNT(*) > 1;
