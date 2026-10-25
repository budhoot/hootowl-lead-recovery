-- One AI receptionist profile per customer. Text here is business-provided and is placed into the
-- assistant's instructions, so every field has a hard length limit.
CREATE TABLE IF NOT EXISTS agent_profiles (
  client_id BIGINT PRIMARY KEY REFERENCES clients(id),
  assistant_name TEXT NOT NULL CHECK (char_length(assistant_name) BETWEEN 1 AND 60),
  business_name TEXT NOT NULL CHECK (char_length(business_name) BETWEEN 1 AND 120),
  name_only_when_asked BOOLEAN NOT NULL DEFAULT TRUE,
  started_on DATE,
  greeting TEXT NOT NULL CHECK (char_length(greeting) BETWEEN 1 AND 300),
  closing_line TEXT NOT NULL DEFAULT '' CHECK (char_length(closing_line) <= 300),
  services TEXT NOT NULL DEFAULT '' CHECK (char_length(services) <= 1000),
  service_latitude DOUBLE PRECISION CHECK (service_latitude BETWEEN -90 AND 90),
  service_longitude DOUBLE PRECISION CHECK (service_longitude BETWEEN -180 AND 180),
  service_radius_miles INTEGER NOT NULL DEFAULT 100 CHECK (service_radius_miles BETWEEN 1 AND 500),
  service_area_label TEXT NOT NULL DEFAULT '' CHECK (char_length(service_area_label) <= 200),
  place_hints TEXT NOT NULL DEFAULT '' CHECK (char_length(place_hints) <= 600),
  tts_provider TEXT NOT NULL DEFAULT 'ElevenLabs' CHECK (tts_provider IN ('ElevenLabs', 'Google', 'Amazon')),
  voice_id TEXT CHECK (voice_id IS NULL OR voice_id ~ '^[A-Za-z0-9._-]{1,100}$'),
  ready BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((service_latitude IS NULL) = (service_longitude IS NULL))
);

-- Carry the original single-customer assistant (Nocona Hills, "CindyLou Hoot") over unchanged.
INSERT INTO agent_profiles(client_id,assistant_name,business_name,name_only_when_asked,started_on,greeting,closing_line,
  service_latitude,service_longitude,service_radius_miles,service_area_label,place_hints,tts_provider,voice_id,ready)
SELECT id,'CindyLou Hoot','Nocona Hills Repair and Replace',TRUE,DATE '2026-10-24',
  'Hey thanks for calling Nocona Hills Repair and Replace. How can we assist you today?',
  'Of course we can be there within the hour! We will put you on the schedule and see you shortly! Thanks for your business!',
  33.8456,-97.6399,100,'Nocona Hills, Texas, including nearby Oklahoma',
  'Speech recognition may mishear local places: "Nokona", "Nikona", or "Knocona" mean Nocona, Texas. Nearby towns include Nocona Hills, Saint Jo, Bowie, Montague, Ringgold, and Wichita Falls.',
  'ElevenLabs','aEO01A4wXwd1O8GPgGlF',TRUE
FROM clients WHERE name ILIKE 'Nocona Hills Repair%' ORDER BY id LIMIT 1
ON CONFLICT (client_id) DO NOTHING;
