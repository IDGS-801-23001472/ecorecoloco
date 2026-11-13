-- Aplicar una sola vez sobre la base eco_reco existente.
ALTER TABLE contratos
  ADD COLUMN kilos_mensuales DECIMAL(10,2) NULL,
  ADD COLUMN tarifa_excedente DECIMAL(10,2) NULL,
  ADD COLUMN iva_porcentaje DECIMAL(5,2) NULL;

ALTER TABLE recolecciones ADD COLUMN orden_parada INT NULL,
  ADD INDEX idx_recolecciones_chofer_fecha (fk_chofer, fecha_recoleccion),
  ADD INDEX idx_recolecciones_contrato_fecha (fk_contrato, fecha_recoleccion);

CREATE TABLE servicios_chofer (
  fk_recoleccion INT PRIMARY KEY,
  fk_usuario INT NOT NULL,
  estado ENUM('en_curso','completada','fallida') NOT NULL,
  llegada DATETIME NOT NULL,
  cierre DATETIME NULL,
  motivo VARCHAR(255),
  insumos VARCHAR(255),
  foto MEDIUMBLOB,
  firma MEDIUMBLOB,
  fk_venta INT UNIQUE,
  fk_manifiesto INT UNIQUE,
  FOREIGN KEY (fk_recoleccion) REFERENCES recolecciones(pk_recoleccion),
  FOREIGN KEY (fk_usuario) REFERENCES usuarios(pk_usuario),
  FOREIGN KEY (fk_venta) REFERENCES ventas(pk_venta),
  FOREIGN KEY (fk_manifiesto) REFERENCES manifiestos(pk_manifiesto)
);

ALTER TABLE ventas_detalle ADD COLUMN concepto VARCHAR(120) NULL;
ALTER TABLE manifiestos ADD COLUMN cliente_nombre VARCHAR(120) NULL,
  ADD COLUMN chofer_nombre VARCHAR(120) NULL;

CREATE TABLE entregas_manifiesto_chofer (
  fk_manifiesto INT PRIMARY KEY,
  fk_usuario INT NOT NULL,
  fecha_entrega DATETIME NOT NULL,
  FOREIGN KEY (fk_manifiesto) REFERENCES manifiestos(pk_manifiesto),
  FOREIGN KEY (fk_usuario) REFERENCES usuarios(pk_usuario)
);

CREATE TABLE pagos_chofer (
  pk_pago INT PRIMARY KEY AUTO_INCREMENT,
  fk_venta INT NOT NULL,
  fk_usuario INT NOT NULL,
  fk_turno INT NOT NULL,
  fk_metodo_pago INT NOT NULL,
  importe DECIMAL(10,2) NOT NULL,
  fecha DATETIME NOT NULL,
  clave CHAR(36) NOT NULL,
  UNIQUE (fk_usuario, clave),
  INDEX (fk_usuario, fk_turno, fecha),
  FOREIGN KEY (fk_venta) REFERENCES ventas(pk_venta),
  FOREIGN KEY (fk_usuario) REFERENCES usuarios(pk_usuario),
  FOREIGN KEY (fk_turno) REFERENCES turnos(pk_turno),
  FOREIGN KEY (fk_metodo_pago) REFERENCES metodos_pago(pk_metodo_pago)
);

CREATE TABLE cierres_chofer (
  fk_corte INT PRIMARY KEY,
  fk_usuario INT NOT NULL,
  fk_turno INT NOT NULL,
  jornada DATE NOT NULL,
  efectivo_esperado DECIMAL(10,2) NOT NULL,
  efectivo_contado DECIMAL(10,2) NOT NULL,
  diferencia DECIMAL(11,2) NOT NULL,
  fk_revisor INT NULL,
  fecha_revision DATETIME NULL,
  nota_revision VARCHAR(255) NULL,
  UNIQUE (fk_usuario, fk_turno, jornada),
  FOREIGN KEY (fk_corte) REFERENCES cortes(pk_corte),
  FOREIGN KEY (fk_usuario) REFERENCES usuarios(pk_usuario),
  FOREIGN KEY (fk_turno) REFERENCES turnos(pk_turno),
  FOREIGN KEY (fk_revisor) REFERENCES usuarios(pk_usuario)
);

-- Permiten reintentar la captura y conservar el turno real del gasto.
ALTER TABLE viaticos ADD COLUMN fk_turno INT NULL, ADD COLUMN clave CHAR(36) NULL,
  ADD UNIQUE (fk_usuario, clave), ADD INDEX (fk_usuario, fk_turno, fecha);
ALTER TABLE cortes_detalle ADD COLUMN fk_pago INT NULL,
  ADD FOREIGN KEY (fk_pago) REFERENCES pagos_chofer(pk_pago);
