package sample.app

import sample.scalautil.formatName

trait Renderable

class BaseWidget

class Widget(name: String) extends BaseWidget with Renderable {
  def render(): String = formatName(name)
}
