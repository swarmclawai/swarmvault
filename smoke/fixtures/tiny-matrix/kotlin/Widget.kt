package sample.app

import sample.util.formatName

interface Renderable

open class BaseWidget

class Widget(private val name: String) : BaseWidget(), Renderable {
  fun render(): String = formatName(name)
}
