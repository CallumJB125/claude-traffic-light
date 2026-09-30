-- Runner-reported form factor (hello.form_factor), shown as CardView.device_kind
-- ("laptop asleep" vs "desktop asleep"). NULL when the runner didn't say.
ALTER TABLE devices ADD COLUMN form_factor TEXT CHECK (form_factor IN ('laptop','desktop'));
