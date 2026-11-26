import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:talkie/ui/widgets.dart';

void main() {
  testWidgets('the Talkie logo renders', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: Center(child: LogoMark(size: 48)))));
    expect(find.byType(LogoMark), findsOneWidget);
  });
}
