import 'package:flutter/material.dart';

import '../../services/chofer_api.dart';
import '../chofer/chofer_widgets.dart';
import '../chofer/manifiesto_pdf.dart';
import 'agenda_screen.dart';

class ClienteHome extends StatefulWidget {
  const ClienteHome({super.key, required this.api, required this.nombre});

  final ChoferApi api;
  final String nombre;

  @override
  State<ClienteHome> createState() => _ClienteHomeState();
}

class _ClienteHomeState extends State<ClienteHome> {
  late Future<Json> _visits;
  Future<Json>? _account;
  int _section = 0;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _visits = widget.api.get('cliente/visitas');
  }

  void _refresh() => setState(() {
    if (_section == 0) {
      _visits = widget.api.get('cliente/visitas');
    } else {
      _account = widget.api.get('cliente/cuenta');
    }
  });

  Future<void> _change(Json visit, String action, String today) async {
    final body = <String, dynamic>{'accion': action};
    if (action == 'reprogramar') {
      final day = await pickOperationDay(context, today, minimum: today);
      if (day == null || !mounted) return;
      body['fecha'] = day;
    }
    if (action == 'cancelar') {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Cancelar visita'),
          content: const Text(
            'La cancelación aplica únicamente a esta visita.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Volver'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Cancelar visita'),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
    }
    setState(() => _busy = true);
    try {
      await widget.api.post('cliente/visitas/${visit['id']}', body);
      if (mounted) _refresh();
    } on ChoferError catch (error) {
      if (mounted) showMessage(context, error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text('Cliente · ${widget.nombre}'),
      actions: [
        IconButton(
          onPressed: _busy ? null : _refresh,
          tooltip: 'Actualizar',
          icon: const Icon(Icons.refresh),
        ),
        IconButton(
          onPressed: () => closeSession(context, widget.api),
          tooltip: 'Cerrar sesión',
          icon: const Icon(Icons.logout),
        ),
      ],
    ),
    body: AsyncContent(
      future: _section == 0 ? _visits : _account!,
      retry: _refresh,
      builder: _section == 0 ? _visitList : _accountList,
    ),
    bottomNavigationBar: NavigationBar(
      selectedIndex: _section,
      onDestinationSelected: _busy
          ? null
          : (index) => setState(() {
              _section = index;
              if (index == 1) _account ??= widget.api.get('cliente/cuenta');
            }),
      destinations: const [
        NavigationDestination(
          icon: Icon(Icons.event_outlined),
          label: 'Visitas',
        ),
        NavigationDestination(
          icon: Icon(Icons.folder_open),
          label: 'Mi cuenta',
        ),
      ],
    ),
  );

  Widget _visitList(Json data) {
    final today = data['fecha'] as String;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          'Mis recolecciones',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        if (rows(data, 'items').isEmpty)
          const Text('Todavía no tienes recolecciones.'),
        for (final visit in rows(data, 'items')) _visitCard(visit, today),
      ],
    );
  }

  Widget _visitCard(Json visit, String today) {
    final date = (visit['fecha'] as String).substring(0, 10);
    final active = visit['activo'] == 1;
    final recovery =
        visit['respuesta_cliente'] == 'cancelada' &&
        visit['frecuencia'] == 'Mensual' &&
        date.substring(0, 7) == today.substring(0, 7);
    final editable =
        visit['servicio'] == 'pendiente' &&
        (recovery || (active && date.compareTo(today) >= 0));
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${visit['folio']} · $date',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            Text(
              '${(visit['fecha'] as String).substring(11, 16)} · ${visit['respuesta_cliente']}',
            ),
            if (visit['servicio'] != 'pendiente')
              Text(stopStatus(visit['servicio'] as String)),
            if (editable)
              Wrap(
                children: [
                  if (active && visit['respuesta_cliente'] != 'confirmada')
                    TextButton(
                      onPressed: _busy
                          ? null
                          : () => _change(visit, 'confirmar', today),
                      child: const Text('Confirmar'),
                    ),
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => _change(visit, 'reprogramar', today),
                    child: const Text('Reprogramar'),
                  ),
                  if (active)
                    TextButton(
                      onPressed: _busy
                          ? null
                          : () => _change(visit, 'cancelar', today),
                      child: const Text('Cancelar visita'),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  Widget _accountList(Json data) => ListView(
    padding: const EdgeInsets.all(16),
    children: [
      for (final notice in rows(data, 'avisos'))
        Card(
          child: ListTile(
            leading: const Icon(Icons.campaign_outlined),
            title: Text('${notice['titulo']}'),
            subtitle: Text('${notice['descripcion']}'),
          ),
        ),
      for (final client in rows(data, 'clientes'))
        ListTile(
          title: Text('${client['nombre']}'),
          subtitle: Text('${client['direccion'] ?? ''}'),
        ),
      _heading('Contratos'),
      for (final item in rows(data, 'contratos'))
        ListTile(
          title: Text('${item['folio']}'),
          subtitle: Text(
            '${item['inicio']} a ${item['fin']} · ${item['frecuencia']}',
          ),
        ),
      _heading('Estado de cuenta'),
      for (final item in rows(data, 'ventas'))
        ListTile(
          title: Text('${item['folio']}'),
          subtitle: Text(
            'Total ${mxn(item['total'])} · Saldo ${mxn(item['saldo'])}',
          ),
        ),
      _heading('Manifiestos'),
      for (final item in rows(data, 'manifiestos'))
        ListTile(
          title: Text('${item['folio']}'),
          subtitle: Text('${item['fecha']}'),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) =>
                  _CustomerManifest(api: widget.api, id: item['id'] as int),
            ),
          ),
        ),
    ],
  );

  Widget _heading(String title) => Padding(
    padding: const EdgeInsets.only(top: 14),
    child: Text(title, style: Theme.of(context).textTheme.titleLarge),
  );
}

class _CustomerManifest extends StatefulWidget {
  const _CustomerManifest({required this.api, required this.id});
  final ChoferApi api;
  final int id;

  @override
  State<_CustomerManifest> createState() => _CustomerManifestState();
}

class _CustomerManifestState extends State<_CustomerManifest> {
  late Future<Json> _data;

  @override
  void initState() {
    super.initState();
    _data = _load();
  }

  Future<Json> _load() => widget.api.get('cliente/manifiestos/${widget.id}');

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Manifiesto')),
    body: AsyncContent(
      future: _data,
      retry: () {
        final next = _load();
        setState(() {
          _data = next;
        });
      },
      builder: (data) => ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
            '${data['folio']}',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          Text('Origen · ${data['origen'] ?? 'Sin dato'}'),
          Text('Destino · ${data['destino'] ?? 'Sin dato'}'),
          Text('Chofer · ${data['chofer'] ?? 'Sin dato'}'),
          Text('Emisión · ${data['emision']}'),
          if (data['entrega'] != null) Text('Entrega · ${data['entrega']}'),
          ManifiestoPdfButton(manifest: data, items: rows(data, 'items')),
          for (final item in rows(data, 'items'))
            ListTile(
              title: Text('${item['descripcion']}'),
              subtitle: Text(
                'Cantidad ${item['cantidad']} · ${item['peso']} kg',
              ),
            ),
        ],
      ),
    ),
  );
}
