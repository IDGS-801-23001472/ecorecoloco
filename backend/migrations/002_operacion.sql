-- Aplicar una vez después de 001_chofer.sql.
ALTER TABLE contratos ADD COLUMN hora_servicio TIME NULL,
  ADD COLUMN cargo_visita_fallida DECIMAL(10,2) NULL;
ALTER TABLE recolecciones
  ADD COLUMN respuesta_cliente ENUM('pendiente','confirmada','reprogramada','cancelada') NOT NULL DEFAULT 'pendiente',
  ADD COLUMN publicada TINYINT NOT NULL DEFAULT 1,
  ADD INDEX idx_recolecciones_plan (fk_ruta, fk_turno, fecha_recoleccion),
  ADD INDEX idx_recolecciones_cliente (fk_cliente, fecha_recoleccion);
CREATE TABLE visitas_generadas (
  fk_contrato INT NOT NULL,
  fecha_original DATE NOT NULL,
  fk_recoleccion INT NOT NULL UNIQUE,
  PRIMARY KEY (fk_contrato, fecha_original),
  FOREIGN KEY (fk_contrato) REFERENCES contratos(pk_contrato),
  FOREIGN KEY (fk_recoleccion) REFERENCES recolecciones(pk_recoleccion)
);
CREATE TABLE bitacora_operacion (
  pk_evento BIGINT PRIMARY KEY AUTO_INCREMENT,
  fk_usuario INT NOT NULL,
  recurso VARCHAR(60) NOT NULL,
  recurso_id INT NOT NULL,
  accion VARCHAR(40) NOT NULL,
  fecha DATETIME NOT NULL,
  INDEX (recurso, recurso_id, fecha),
  FOREIGN KEY (fk_usuario) REFERENCES usuarios(pk_usuario)
);
CREATE TABLE banners (
  pk_banner INT PRIMARY KEY AUTO_INCREMENT,
  titulo VARCHAR(120) NOT NULL,
  descripcion VARCHAR(255) NOT NULL,
  estado INT NOT NULL DEFAULT 1
);
