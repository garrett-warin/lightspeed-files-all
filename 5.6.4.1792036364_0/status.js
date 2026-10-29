(function() {
  const MainMenu = React.createClass({
    getInitialState: function() {
      const self = this;
      chrome.runtime.sendMessage({target: 'real_time', query: 'getState'}, (response) => {
        const stateUpdate = {
          hpActive: response.hpActive,
          hpEnabled: response.hpEnabled
        };
        if (response.currentState) {
          stateUpdate.current = response.currentState;
        }
        if (Array.isArray(response.groups)) {
          stateUpdate.groups = response.groups;
        }
        self.setState(stateUpdate);
      });
      return {
        current: 'working'
      };
    },
    updateCurrent: function(newState) {
      const self = this;
      chrome.runtime.sendMessage({target: 'real_time', newState: newState}, () => {
        self.setState({
          current: newState
        });
        window.close();
      });

    },
    render: function() {
      const elements = [];

      if (this.state.hpActive === true) {
        elements.push(React.createElement('div', {key: 'pass', className: `btn btn-pass`}, 'Active Pass'));
      } else {
        elements.push(React.createElement('div', {key: 'working', className: `btn btn-working ${this.state.current === 'working' ? 'selected' : ''}`, onClick: this.updateCurrent.bind(null, 'working')}, 'Working'));
        elements.push(React.createElement('div', {key: 'need-help', className: `btn btn-needhelp ${this.state.current === 'need help' ? 'selected' : ''}`, onClick: this.updateCurrent.bind(null, 'need help')}, 'Need Help'));
        elements.push(React.createElement('div', {key: 'done', className: `btn btn-done ${this.state.current === 'done' ? 'selected' : ''}`, onClick: this.updateCurrent.bind(null, 'done')}, 'Done'));

        if (this.state.hpEnabled === true) {
          elements.push(React.createElement('div', {key: 'separator', className: 'separator'}));
          elements.push(React.createElement('div', {key: 'pass', className: `btn btn-pass ${this.state.current === 'request pass' ? 'selected' : ''}`, onClick: this.updateCurrent.bind(null, 'request pass')}, 'Request Pass'));
        }
      }

      return React.createElement(
        'div',
        {className: 'MainMenu'},
        elements
      );
    }
  });

  window.onload = function() {
    React.render(
      React.createElement(MainMenu, {}),
      document.getElementById('menu-content')
    );
  };

}).call(this);
