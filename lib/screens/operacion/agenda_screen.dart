import 'package:flutter/material.dart';

import '../../services/chofer_api.dart';
import '../chofer/chofer_widgets.dart';

Future<String?> pickOperationDay(
  BuildContext context,
  String day, {
  String? minimum,
}) async {
  final selected = await showDatePicker(
    context: context,
    initialDate: DateTime.parse(day),
    firstDate: minimum == null ? DateTime(2000) : DateTime.parse(minimum),
    lastDate: DateTime(2100, 12, 31),
  );
  return selected == null ? null : isoDay(selected);
}

class AgendaScreen extends StatefulWidget {
  const AgendaScreen({super.key, required this.api});
  final ChoferApi api;

  @override
  State<AgendaScreen> createState() => _AgendaScreenState();
}

class _AgendaScreenState extends State<AgendaScreen> {
  late Future<Json> _data;
  final _selected = <int>{};
  String? _day;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _data = _load();
  }

  Future<Json> _load() =>
      widget.api.get('agenda', _day == null ? null : {'fecha': _day!});
  void _refresh() {
    final next = _load();
    setState(() {
      _data = next;
    });
  }

  Future<void> _mutate(
    String path,
    Json body,
    String Function(Json) message,
  ) async {
    setState(() => _busy = true);
    try {
      final result = await widget.api.post(path, body);
      if (!mounted) return;
      _selected.clear();
      _refresh();
      showMessage(context, message(result));
    } on ChoferError catch (error) {
      if (mounted) showMessage(context, error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pick(String day) async {
    final picked = await pickOperationDay(context, day);
    if (picked == null || !mounted) return;
    _selected.clear();
    _day = picked;
    _refresh();
  }

  Future<void> _generate(String today) async {
    final start = DateTime.parse(today);
    final range = await showDateRangePicker(
      context: context,
      firstDate: start,
      lastDate: start.add(const Duration(days: 365)),
      initialDateRange: DateTimeRange(
        start: start,
        end: start.add(const Duration(days: 14)),
      ),
    );
    if (range == null || !mounted) return;
    await _mutate('agenda/generar', {
      'desde': isoDay(range.start),
      'hasta': isoDay(range.end),
    }, (data) => 'Visitas creadas: ${data['creadas']}');
  }

  Future<void> _schedule(Json data) async {
    final contract = await showDialog<int>(
      context: context,
      builder: (_) => SimpleDialog(
        title: Text('Programar visita · ${data['fecha']}'),
        children: [
          if (rows(data, 'contratos').isEmpty)
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('Registra un contrato activo primero.'),
            ),
          for (final item in rows(data, 'contratos'))
            SimpleDialogOption(
              onPressed: () => Navigator.pop(context, item['id'] as int),
              child: Text('${item['nombre']}'),
            ),
        ],
      ),
    );
    if (contract == null || !mounted) return;
    await _mutate('agenda/programar', {
      'fecha': data['fecha'],
      'fk_contrato': contract,
    }, (_) => 'Visita programada.');
  }

  Future<void> _assign(Json data) async {
    final selection = await showDialog<Json>(
      context: context,
      builder: (_) => _AssignmentDialog(data: data),
    );
    if (selection == null || !mounted) return;
    await _mutate(
      'agenda/asignar',
      {...selection, 'fecha': data['fecha'], 'paradas': _selected.toList()},
      (data) => selection['publicar'] == true
          ? 'Paradas publicadas: ${data['asignadas']}'
          : 'Paradas en borrador: ${data['asignadas']}',
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Calendario y rutas')),
    body: AsyncContent(
      future: _data,
      retry: _refresh,
      builder: (data) {
        final day = data['fecha'] as String;
        final today = data['hoy'] as String;
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Wrap(
              spacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: _busy ? null : () => _pick(day),
                  icon: const Icon(Icons.calendar_today),
                  label: Text(day),
                ),
                OutlinedButton(
                  onPressed: _busy ? null : () => _generate(today),
                  child: const Text('Generar visitas'),
                ),
                OutlinedButton(
                  onPressed: _busy || day.compareTo(today) < 0
                      ? null
                      : () => _schedule(data),
                  child: const Text('Programar una visita'),
                ),
                FilledButton(
                  onPressed: _busy || _selected.isEmpty
                      ? null
                      : () => _assign(data),
                  child: Text('Asignar (${_selected.length})'),
                ),
              ],
            ),
            const Text('Selecciona las paradas en el orden de visita.'),
            if (rows(data, 'items').isEmpty)
              const Text('Sin visitas programadas para esta fecha.'),
            for (final visit in rows(data, 'items'))
              _visit(visit, day.compareTo(today) >= 0),
          ],
        );
      },
    ),
  );

  Widget _visit(Json visit, bool current) {
    final id = visit['id'] as int;
    final available =
        current && visit['activo'] == 1 && visit['servicio'] == 'pendiente';
    final assigned = visit['fk_ruta'] != null;
    final position = _selected.toList().indexOf(id);
    return Card(
      child: ListTile(
        leading: available
            ? Checkbox(
                value: position >= 0,
                onChanged: _busy
                    ? null
                    : (value) => setState(() {
                        if (value == true) {
                          _selected.add(id);
                        } else {
                          _selected.remove(id);
                        }
                      }),
              )
            : const Icon(Icons.event_note_outlined),
        title: Text(
          '${position >= 0 ? '${position + 1}. ' : ''}${visit['cliente']}',
        ),
        subtitle: Text(
          '${visit['folio']} · ${visit['respuesta_cliente']}\n'
          '${visit['fecha'].toString().substring(11, 16)} · '
          '${assigned ? "${visit['ruta']} / ${visit['chofer']}" : "Sin asignar"}'
          '${assigned && visit['publicada'] == 0 ? ' · Borrador' : ''}',
        ),
        trailing: available && assigned
            ? IconButton(
                tooltip: 'Desasignar',
                onPressed: _busy
                    ? null
                    : () => _mutate(
                        'agenda/$id/desasignar',
                        {},
                        (_) => 'Parada desasignada.',
                      ),
                icon: const Icon(Icons.link_off),
              )
            : null,
      ),
    );
  }
}

class _AssignmentDialog extends StatefulWidget {
  const _AssignmentDialog({required this.data});
  final Json data;

  @override
  State<_AssignmentDialog> createState() => _AssignmentDialogState();
}

class _AssignmentDialogState extends State<_AssignmentDialog> {
  final values = <String, int>{};
  bool _publish = false;
  static const choices = {
    'rutas': ('fk_ruta', 'Ruta'),
    'choferes': ('fk_chofer', 'Chofer'),
    'turnos': ('fk_turno', 'Turno'),
  };

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Asignar paradas'),
    content: SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final entry in choices.entries)
            DropdownButtonFormField<int>(
              initialValue: values[entry.value.$1],
              decoration: InputDecoration(labelText: entry.value.$2),
              isExpanded: true,
              items: [
                for (final item in rows(widget.data, entry.key))
                  DropdownMenuItem(
                    value: item['id'] as int,
                    child: Text(
                      '${item['nombre']}',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
              onChanged: (value) {
                if (value != null) {
                  setState(() => values[entry.value.$1] = value);
                }
              },
            ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: _publish,
            onChanged: (value) => setState(() => _publish = value),
            title: const Text('Publicar para el chofer'),
            subtitle: const Text(
              'Revisa las confirmaciones antes de publicar.',
            ),
          ),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancelar'),
      ),
      FilledButton(
        onPressed: values.length == choices.length
            ? () => Navigator.pop(context, <String, dynamic>{
                ...values,
                'publicar': _publish,
              })
            : null,
        child: const Text('Asignar'),
      ),
    ],
  );
}
