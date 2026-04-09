library tiny.app.widget;

import 'package:tiny_app/helper.dart';

mixin Loggable {}

class BaseWidget {}
class Runner {}

extension WidgetLabels on Widget {
  String label() => formatName('label');
}

class Widget extends BaseWidget with Loggable implements Runner {
  Widget();

  String run() {
    return formatName('run');
  }
}
