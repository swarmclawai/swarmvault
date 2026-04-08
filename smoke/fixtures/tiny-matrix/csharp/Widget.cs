namespace Example.App;

using System;

public interface IRenderable {}

public class Widget : BaseWidget, IRenderable {
  public string Run(string name) {
    return $"CSharp:{name}";
  }
}
