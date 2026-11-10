ALTER TABLE "tasks" ALTER COLUMN "notification" DROP DEFAULT;
ALTER TABLE "tasks" ALTER COLUMN "notification" TYPE jsonb USING
  CASE "notification"
    WHEN 'none' THEN '{"email":{"enabled":false,"when":"always"}}'::jsonb
    WHEN 'email_on_change' THEN '{"email":{"enabled":true,"when":"on_change"}}'::jsonb
    WHEN 'email' THEN '{"email":{"enabled":true,"when":"always"}}'::jsonb
    ELSE "notification"::jsonb
  END;
ALTER TABLE "tasks" ALTER COLUMN "notification" SET DEFAULT '{"email":{"enabled":true,"when":"always"}}'::jsonb;
