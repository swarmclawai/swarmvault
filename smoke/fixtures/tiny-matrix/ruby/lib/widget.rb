require_relative "helper"

module Tiny
  class Widget
    def render(name)
      Tiny.format_label(name)
    end
  end
end
