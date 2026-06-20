-- Trabalho do aluno POR INTERAÇÃO no run de cenário. Mapa
-- { [interactionId]: { filename, file_id, vector_store_id, uploaded_at } } — cada
-- interação marcada com includes_student_work pode receber o upload do aluno, que
-- vira file_search para a persona consultar. Aditivo, não-destrutivo.
ALTER TABLE scenario_runs ADD COLUMN student_work_json JSONB;
