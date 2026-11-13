import 'package:flutter/material.dart';

import '../../services/chofer_api.dart';
import 'chofer_caja.dart';
import 'chofer_parada.dart';
import 'chofer_widgets.dart';

class ChoferHome extends StatefulWidget {
  const ChoferHome({super.key, required this.nombre, required this.api});

  final String nombre;
  final ChoferApi api;

  @override
  State<ChoferHome> createState() => _ChoferHomeState();
}

class _ChoferHomeState extends State<ChoferHome> {
  late Future<Json> _data;
  String? _fecha;

  @override
  void initState() {
    super.initState();
    _data = _load();
  }

  Future<Json> _load() =>
      widget.api.get('paradas', _fecha == null ? null : {'fecha': _fecha!});

  void _refresh() {
    final next = _load();
    setState(() {
      _data = next;
    });
  }

  Future<void> _pickDate(String day) async {
    final selected = await showDatePicker(
      context: context,
      initialDate: DateTime.parse(day),
      firstDate: DateTime(2000),
      lastDate: DateTime(2100),
    );
    if (selected != null && mounted) {
      setState(() {
        _fecha = isoDay(selected);
        _data = _load();
      });
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Chofer · Ruta del día'),
      actions: [
        IconButton(
          tooltip: 'Actualizar',
          onPressed: _refresh,
          icon: const Icon(Icons.refresh),
        ),
        IconButton(
          tooltip: 'Cerrar sesión',
          onPressed: () => closeSession(context, widget.api),
          icon: const Icon(Icons.logout),
        ),
      ],
    ),
    body: AsyncContent(
      future: _data,
      retry: _refresh,
      builder: (data) {
        final day = data['fecha'] as String;
        final stops = rows(data, 'paradas');
        final shifts = <int, String>{
          for (final stop in stops)
            stop['fk_turno'] as int: stop['turno'] as String,
        };
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(
              widget.nombre,
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            Wrap(
              spacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: () => _pickDate(day),
                  icon: const Icon(Icons.calendar_today),
                  label: Text(day),
                ),
                TextButton.icon(
                  onPressed: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => _History(api: widget.api, day: day),
                    ),
                  ),
                  icon: const Icon(Icons.receipt_long),
                  label: const Text('Historial de ventas'),
                ),
                TextButton.icon(
                  onPressed: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) =>
                          _History(api: widget.api, day: day, manifests: true),
                    ),
                  ),
                  icon: const Icon(Icons.description_outlined),
                  label: const Text('Manifiestos'),
                ),
              ],
            ),
            if (stops.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 32),
                child: Text('No tienes paradas asignadas para esta fecha.'),
              ),
            for (var index = 0; index < stops.length; index++)
              _stopTile(stops, index),
            if (shifts.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text(
                'Caja por turno',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              for (final shift in shifts.entries)
                ListTile(
                  leading: const Icon(Icons.account_balance_wallet_outlined),
                  title: Text(shift.value),
                  subtitle: const Text('Pagos, viáticos y corte'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => ChoferCaja(
                        api: widget.api,
                        day: day,
                        shift: shift.key,
                        name: shift.value,
                      ),
                    ),
                  ),
                ),
            ],
          ],
        );
      },
    ),
  );

  Widget _stopTile(List<Json> stops, int index) {
    final stop = stops[index];
    final previous = index > 0 ? stops[index - 1] : null;
    final startsGroup =
        previous?['fk_turno'] != stop['fk_turno'] ||
        previous?['fk_ruta'] != stop['fk_ruta'];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (startsGroup)
          Padding(
            padding: const EdgeInsets.fromLTRB(0, 16, 0, 4),
            child: Text(
              '${stop['turno']} · ${stop['ruta']}',
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
        Card(
          child: ListTile(
            leading: const Icon(Icons.location_on_outlined),
            title: Text('${stop['cliente']}'),
            subtitle: Text(
              '${(stop['fecha'] as String).substring(11, 16)} · '
              '${stopStatus(stop['estado'] as String)}\n${stop['direccion'] ?? ''}',
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () async {
              await Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => ChoferParada(
                    api: widget.api,
                    id: stop['pk_recoleccion'] as int,
                  ),
                ),
              );
              if (mounted) _refresh();
            },
          ),
        ),
      ],
    );
  }
}

class _History extends StatefulWidget {
  const _History({
    required this.api,
    required this.day,
    this.manifests = false,
  });

  final ChoferApi api;
  final String day;
  final bool manifests;

  @override
  State<_History> createState() => _HistoryState();
}

class _HistoryState extends State<_History> {
  final _filter = TextEditingController();
  late Future<Json> _data;

  Future<Json> _load() =>
      widget.api.get(widget.manifests ? 'manifiestos' : 'ventas', {
        'fecha': widget.day,
        (widget.manifests ? 'folio' : 'cliente'): _filter.text.trim(),
      });

  @override
  void initState() {
    super.initState();
    _data = _load();
  }

  @override
  void dispose() {
    _filter.dispose();
    super.dispose();
  }

  void _refresh() {
    final next = _load();
    setState(() {
      _data = next;
    });
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(
        '${widget.manifests ? 'Manifiestos' : 'Ventas'} · ${widget.day}',
      ),
    ),
    body: Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(16),
          child: TextField(
            controller: _filter,
            onSubmitted: (_) => _refresh(),
            decoration: InputDecoration(
              labelText: widget.manifests
                  ? 'Buscar por folio'
                  : 'Filtrar por cliente',
              suffixIcon: IconButton(
                tooltip: 'Buscar',
                onPressed: _refresh,
                icon: const Icon(Icons.search),
              ),
            ),
          ),
        ),
        Expanded(
          child: AsyncContent(
            future: _data,
            retry: _refresh,
            builder: (data) {
              final items = rows(
                data,
                widget.manifests ? 'manifiestos' : 'ventas',
              );
              if (items.isEmpty) {
                return const Center(child: Text('No hay resultados.'));
              }
              return ListView(
                children: [
                  for (final item in items)
                    ListTile(
                      title: Text('${item['folio']} · ${item['cliente']}'),
                      subtitle: Text(
                        widget.manifests
                            ? '${item['fecha']}'
                            : 'Total ${mxn(item['total'])} · Saldo ${mxn(item['saldo'])}',
                      ),
                      onTap: widget.manifests
                          ? () => Navigator.push(
                              context,
                              MaterialPageRoute(
                                builder: (_) => ChoferManifiesto(
                                  api: widget.api,
                                  path: 'paradas/${item['fk_recoleccion']}',
                                ),
                              ),
                            )
                          : null,
                    ),
                ],
              );
            },
          ),
        ),
      ],
    ),
  );
}
